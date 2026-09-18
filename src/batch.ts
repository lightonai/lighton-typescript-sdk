/**
 * Batch ingestion: upload many files into a workspace, inline or as a background job.
 *
 * `Workspace.ingestMany()` coerces paths and Files (expanding glob patterns), validates
 * every local path **up front** (fail fast, before any upload), then uploads
 * concurrently. Rate limiting and the 429 cooldown are handled centrally by the client,
 * so a large batch stays under the cap across uploads *and* status polls with no
 * per-call work here.
 *
 * There is no batch endpoint: this is a client-side orchestrator over `File.create` and
 * `File.wait`.
 *
 * Where the Python SDK needs a `ThreadPoolExecutor`, a `Lock`, an `Event` and a daemon
 * thread, a single-threaded runtime needs none of them: concurrency is a promise pool,
 * "finished" is a promise, and no snapshot can tear because nothing interleaves except
 * at an await.
 */

import type { Transport } from "./client.ts"
import { File } from "./file.ts"
import type { BatchIngest, BatchProgress, FailedIngest } from "./types/batch.ts"

/** A string item carrying any of these is expanded as a glob pattern. */
const GLOB_CHARS = /[*?[]/

export interface BatchOptions {
  /**
   * If false (the default), the first failure throws, inline or from `job.wait()`. If
   * true, failures are collected and the batch carries on.
   */
  ignoreErrors?: boolean
  /** Wait for each upload's ingestion to finish, not just to be accepted. */
  wait?: boolean
  /** Per-file milliseconds to wait for ingestion when `wait` is set. Default 300_000. */
  timeoutMs?: number
  /** Milliseconds between ingestion status checks. Default 2000. */
  pollMs?: number
  /** Concurrent uploads and polls. Default 8. */
  maxConcurrency?: number
  /** Tag ids assigned to every uploaded document. */
  tags?: number[]
}

/**
 * Run `fn` over `items` with a bounded number in flight; return what succeeded.
 *
 * On the first error, workers stop *taking* new items and the error is rethrown once the
 * pool drains.
 *
 * ponytail: already-running uploads still finish, because there is nothing to cancel
 * them with short of threading an AbortSignal through every request. Pass one on the
 * client if a hard stop matters.
 */
async function pool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R | null>,
): Promise<R[]> {
  const out: (R | null)[] = new Array(items.length).fill(null)
  let next = 0
  let firstError: unknown = null

  const worker = async (): Promise<void> => {
    while (next < items.length && firstError === null) {
      const index = next++
      try {
        out[index] = await fn(items[index] as T)
      } catch (error) {
        firstError ??= error
      }
    }
  }

  const workers = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: workers }, worker))
  if (firstError !== null) throw firstError
  return out.filter((value): value is R => value !== null)
}

/** Load `node:fs`/`node:path`, or explain why a path can't be used here. */
async function nodeFs() {
  try {
    const [fs, path] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
    ])
    return { fs, path }
  } catch (error) {
    throw new Error(
      "local paths need a filesystem, which this runtime has no access to. Pass Files carrying a blob instead.",
      { cause: error },
    )
  }
}

/**
 * Coerce items to Files and split into uploadable and pre-failed.
 *
 * Every local path is checked to exist *before* any upload. With `ignoreErrors` unset a
 * missing path throws immediately; with it set, the path goes straight into the failed
 * list.
 *
 * A **string** item containing `*`, `?` or `[` is expanded with `fs.glob`, matches are
 * filtered to real files, and a pattern matching nothing is treated like a missing path.
 * `File` items are always literal. Results are deduped by resolved path, so overlapping
 * patterns (or a file listed both explicitly and by a glob) upload only once.
 */
async function prepare(
  items: readonly (File | string)[],
  ignoreErrors: boolean,
): Promise<{ files: File[]; prefailed: FailedIngest[] }> {
  const files: File[] = []
  const missing: string[] = []
  const seen = new Set<string>()
  let node: Awaited<ReturnType<typeof nodeFs>> | null = null

  const needsFs = items.some(
    (item) => typeof item === "string" || (item instanceof File && item.path),
  )
  if (needsFs) node = await nodeFs()

  const isFile = async (candidate: string): Promise<boolean> => {
    try {
      return (await (node as NonNullable<typeof node>).fs.stat(candidate)).isFile()
    } catch {
      return false
    }
  }

  const take = (file: File, key: string): void => {
    if (seen.has(key)) return // dedupe by resolved path, no double uploads
    seen.add(key)
    files.push(file)
  }

  for (const item of items) {
    if (item instanceof File) {
      if (item.blob) {
        // A blob carries its own bytes; there is nothing on disk to check or dedupe.
        files.push(item)
      } else if (!item.path) {
        throw new Error("cannot ingest a File with no path and no blob")
      } else if (await isFile(item.path)) {
        take(item, (node as NonNullable<typeof node>).path.resolve(item.path))
      } else {
        missing.push(item.path)
      }
      continue
    }

    const { fs, path } = node as NonNullable<typeof node>
    if (GLOB_CHARS.test(item)) {
      const hits: string[] = []
      for await (const hit of fs.glob(item)) {
        if (typeof hit === "string" && (await isFile(hit))) hits.push(hit)
      }
      hits.sort()
      // A zero-match pattern is surfaced like a missing path.
      if (hits.length === 0) missing.push(item)
      for (const hit of hits) take(new File({ path: hit }), path.resolve(hit))
    } else if (await isFile(item)) {
      take(new File({ path: item }), path.resolve(item))
    } else {
      missing.push(item)
    }
  }

  if (missing.length > 0 && !ignoreErrors) {
    throw new Error(
      `${missing.length} path(s)/pattern(s) matched no file: ${missing.join(", ")}`,
    )
  }
  return {
    files,
    prefailed: missing.map((source) => ({
      source,
      error: new Error(`no such file: ${source}`),
    })),
  }
}

/**
 * A running (or finished) batch ingestion.
 *
 * Returned by `Workspace.ingestMany(files, { mode: "async" })`. Uploads (and, when
 * `wait` is set, ingestion polls) run in the background; read `progress`, `succeeded`
 * and `failed` at any time, or block with `wait()`.
 */
export class BatchIngestJob {
  readonly #client: Transport
  readonly #workspaceId: number
  readonly #files: File[]
  readonly #options: Required<Omit<BatchOptions, "tags">> & { tags?: number[] }

  #succeeded: File[] = []
  #failed: FailedIngest[]
  #uploaded = 0
  #ingested = 0
  readonly #total: number
  #done = false
  #error: unknown = null
  #finished: Promise<void> | null = null

  /** @internal */
  constructor(
    client: Transport,
    workspaceId: number,
    files: File[],
    prefailed: FailedIngest[],
    options: BatchOptions,
  ) {
    this.#client = client
    this.#workspaceId = workspaceId
    this.#files = files
    this.#failed = [...prefailed]
    this.#total = files.length + prefailed.length
    this.#options = {
      ignoreErrors: options.ignoreErrors ?? false,
      wait: options.wait ?? false,
      timeoutMs: options.timeoutMs ?? 300_000,
      pollMs: options.pollMs ?? 2000,
      maxConcurrency: options.maxConcurrency ?? 8,
      ...(options.tags ? { tags: options.tags } : {}),
    }
  }

  /** True once every file has reached a terminal state, ok or failed. */
  get done(): boolean {
    return this.#done
  }

  /** A snapshot of the counts, safe to read while the batch runs. */
  get progress(): BatchProgress {
    return {
      total: this.#total,
      uploaded: this.#uploaded,
      ingested: this.#ingested,
      failed: this.#failed.length,
      done: this.#done,
    }
  }

  /** Files that have succeeded so far. */
  get succeeded(): readonly File[] {
    return this.#succeeded
  }

  /** Failures so far, available mid-run. */
  get failed(): readonly FailedIngest[] {
    return this.#failed
  }

  /** Current succeeded/failed as a {@link BatchIngest}; terminal once `done`. */
  get result(): BatchIngest {
    return {
      succeeded: [...this.#succeeded],
      failed: [...this.#failed],
      ok: this.#failed.length === 0,
    }
  }

  /**
   * The current progress.
   *
   * The mirror of a parse/extract job's `poll()`, except that nothing needs fetching:
   * the batch is driven from this process, so its state is already current.
   */
  poll(): BatchProgress {
    return this.progress
  }

  /**
   * Block until the batch finishes, then return its result.
   *
   * @param options - `timeoutMs` for the whole batch; omit to wait indefinitely.
   * @returns The terminal {@link BatchIngest}.
   * @throws Error - If the batch doesn't finish in time.
   * @throws Error - The first upload or ingestion error, rethrown, when the batch ran
   *   without `ignoreErrors`.
   */
  async wait(options: { timeoutMs?: number } = {}): Promise<BatchIngest> {
    const running = this.#finished ?? this.execute()
    if (options.timeoutMs === undefined) {
      await running
    } else {
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("batch ingestion did not finish in time")),
          options.timeoutMs,
        )
      })
      try {
        await Promise.race([running, deadline])
      } finally {
        clearTimeout(timer)
      }
    }
    if (this.#error !== null) throw this.#error
    return this.result
  }

  /**
   * Start the batch, upload phase then (when waiting) ingestion phase.
   *
   * Idempotent: calling it twice returns the same promise, which is what lets `wait()`
   * drive a job that was started in the background.
   *
   * @internal
   */
  execute(): Promise<void> {
    this.#finished ??= this.#run()
    return this.#finished
  }

  /** Run in the background, stashing the error for `wait()` rather than throwing. @internal */
  start(): void {
    void this.execute().catch(() => {
      // Already recorded on #error; swallowed so the job isn't an unhandled rejection.
    })
  }

  async #run(): Promise<void> {
    try {
      const uploaded = await pool(this.#files, this.#options.maxConcurrency, (file) =>
        this.#uploadOne(file),
      )
      if (this.#options.wait && uploaded.length > 0) {
        await pool(uploaded, this.#options.maxConcurrency, (file) =>
          this.#waitOne(file),
        )
      }
    } catch (error) {
      this.#error = error
      throw error
    } finally {
      this.#done = true
    }
  }

  async #uploadOne(file: File): Promise<File | null> {
    try {
      file.workspaceId = this.#workspaceId
      const created = await file.create(
        this.#client,
        this.#options.tags ? { tags: this.#options.tags } : {},
      )
      this.#uploaded += 1
      // Without an ingestion wait, an accepted upload already counts as succeeded.
      if (!this.#options.wait) this.#succeeded.push(created)
      return created
    } catch (error) {
      this.#record(file, error)
      if (!this.#options.ignoreErrors) throw error
      return null
    }
  }

  async #waitOne(file: File): Promise<File | null> {
    try {
      await file.wait({
        timeoutMs: this.#options.timeoutMs,
        pollMs: this.#options.pollMs,
      })
      this.#ingested += 1
      this.#succeeded.push(file)
      return file
    } catch (error) {
      this.#record(file, error, true)
      if (!this.#options.ignoreErrors) throw error
      return null
    }
  }

  #record(file: File, error: unknown, ingested = false): void {
    this.#failed.push({
      source: file.path ?? file.filename ?? "",
      error: error instanceof Error ? error : new Error(String(error)),
      ...(ingested ? { file } : {}),
    })
  }
}

/**
 * Validate, then run the batch inline or in the background.
 *
 * Validation runs before either, so a bad path throws at the call site rather than
 * inside a job nobody is awaiting yet.
 *
 * @internal
 */
export async function runBatch(
  client: Transport,
  workspaceId: number,
  items: readonly (File | string)[],
  options: BatchOptions & { async?: boolean },
): Promise<BatchIngest | BatchIngestJob> {
  const { files, prefailed } = await prepare(items, options.ignoreErrors ?? false)
  const job = new BatchIngestJob(client, workspaceId, files, prefailed, options)
  if (options.async) {
    job.start()
    return job
  }
  await job.execute() // inline; throws directly when ignoreErrors is unset
  return job.result
}
