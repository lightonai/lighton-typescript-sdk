/** Handles for async `parse` and `extract` jobs. */

import type { Transport } from "./client.ts"
import { JobStatus } from "./enums.ts"
import { LightOnError } from "./errors.ts"
import type {
  ExtractDocument,
  ExtractResult,
  ExtractUsage,
  JobProgress,
  ParseDocument,
  ParseError,
  ParseResult,
  ParseUsage,
} from "./types/index.ts"

const sleep = (seconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000))

/** Fields every job response carries. */
interface JobFields {
  id: string
  status: string
  createdAt?: string | null
  completedAt?: string | null
  processingTimeMs?: number | null
  progress?: JobProgress | null
}

/**
 * A queued parse or extract job.
 *
 * Terminal state is `completedAt` being set, not a status string: the API documents only
 * `pending` and `completed` and publishes no failure vocabulary, so a job that ends badly
 * is one whose `completedAt` is set while `succeeded` is false.
 */
export abstract class Job implements JobFields {
  id = ""
  status = ""
  createdAt?: string | null
  completedAt?: string | null
  processingTimeMs?: number | null
  progress?: JobProgress | null

  readonly #transport: Transport
  readonly #path: string

  protected constructor(
    transport: Transport,
    path: string,
    data: Record<string, unknown>,
  ) {
    this.#transport = transport
    this.#path = path
    this.absorb(data)
  }

  /** Field names this job copies off a response. Subclasses widen it. */
  protected static fields: readonly string[] = [
    "id",
    "status",
    "createdAt",
    "completedAt",
    "processingTimeMs",
    "progress",
  ]

  /** Whether the job is terminal, successfully or not. */
  get done(): boolean {
    return this.completedAt !== null && this.completedAt !== undefined
  }

  /** Whether the job finished successfully. The one success state. */
  get succeeded(): boolean {
    return this.status === JobStatus.completed
  }

  /** Copy returned fields onto this job, overwriting only what the response carried. */
  protected absorb(data: Record<string, unknown>): this {
    const allowed = (this.constructor as typeof Job).fields
    for (const field of allowed) {
      if (field in data) {
        ;(this as unknown as Record<string, unknown>)[field] = data[field]
      }
    }
    return this
  }

  /**
   * Re-fetch the job, updating it in place.
   *
   * @param options - `page` selects a page of results; extract paginates, parse ignores it.
   * @returns This job, updated, so `while (!(await job.poll()).succeeded)` reads naturally.
   */
  async poll(options: { page?: number } = {}): Promise<this> {
    const data = await this.#transport.request<Record<string, unknown>>(
      "GET",
      `${this.#path}/${this.id}`,
      options.page === undefined ? {} : { params: { page: options.page } },
    )
    return this.absorb(data)
  }

  /**
   * Poll until the job is terminal.
   *
   * @param options - `timeoutMs` before giving up (default 300_000), `pollMs` between
   *   polls (default 2000).
   * @returns This job, finished.
   * @throws Error - If the timeout elapses first.
   * @throws LightOnError - If the job ends in failure.
   */
  async wait(options: { timeoutMs?: number; pollMs?: number } = {}): Promise<this> {
    const timeoutMs = options.timeoutMs ?? 300_000
    const pollMs = options.pollMs ?? 2000
    const deadline = Date.now() + timeoutMs
    while (!this.done) {
      if (Date.now() > deadline) {
        throw new Error(`job ${this.id} did not finish within ${timeoutMs}ms`)
      }
      await sleep(pollMs / 1000)
      await this.poll()
    }
    if (!this.succeeded) {
      const detail = "error" in this ? this.error : null
      throw new LightOnError(
        `job ${this.id} failed: ${detail ? JSON.stringify(detail) : this.status}`,
      )
    }
    return this
  }
}

/** An async `parse` job. Differs from `ExtractJob` only in what it carries. */
export class ParseJob extends Job {
  document?: ParseDocument | null
  result?: ParseResult | null
  usage?: ParseUsage | null
  /** Set when the parse failed. Only parse reports failure this way. */
  error?: ParseError | null

  protected static override fields = [
    ...Job.fields,
    "document",
    "result",
    "usage",
    "error",
  ]

  /** @internal */
  static from(
    transport: Transport,
    path: string,
    data: Record<string, unknown>,
  ): ParseJob {
    return new ParseJob(transport, path, data)
  }
}

/** An async `extract` job. */
export class ExtractJob extends Job {
  document?: ExtractDocument | null
  result?: ExtractResult | null
  usage?: ExtractUsage | null

  protected static override fields = [...Job.fields, "document", "result", "usage"]

  /** @internal */
  static from(
    transport: Transport,
    path: string,
    data: Record<string, unknown>,
  ): ExtractJob {
    return new ExtractJob(transport, path, data)
  }
}
