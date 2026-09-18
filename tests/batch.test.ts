import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeAll, expect, test } from "vitest"
import { ActiveRecord } from "../src/activeRecord.ts"
import { ExecMode } from "../src/enums.ts"
import { File } from "../src/file.ts"
import { Workspace } from "../src/workspace.ts"
import { json, makeClient } from "./helpers.ts"

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "lighton-batch-"))
  await Promise.all([
    writeFile(join(dir, "a.pdf"), "%PDF a"),
    writeFile(join(dir, "b.pdf"), "%PDF b"),
    writeFile(join(dir, "notes.txt"), "text"),
  ])
})

/** A workspace bound to a fake API that accepts uploads and reports a status. */
function workspace(
  handler: (request: Request, uploads: number) => Response | Promise<Response>,
): { ws: Workspace; count: () => number } {
  let uploads = 0
  const client = makeClient((request) => {
    if (request.method === "POST" && request.url.endsWith("/files")) uploads += 1
    return handler(request, uploads)
  })
  return {
    ws: ActiveRecord.hydrate(Workspace, client, { id: 42, name: "Legal" }),
    count: () => uploads,
  }
}

const accepted = (id: number, status = "pending") =>
  json({ id, workspace_id: 42, status })

// --- validation happens before any upload -----------------------------------

test("a missing path throws before anything is uploaded", async () => {
  const { ws, count } = workspace(() => accepted(1))
  await expect(ws.ingestMany([join(dir, "nope.pdf")])).rejects.toThrow(
    /matched no file/,
  )
  expect(count(), "validation must run before the first upload").toBe(0)
})

test("with ignoreErrors a missing path lands in failed instead", async () => {
  const { ws } = workspace(() => accepted(1))
  const result = await ws.ingestMany([join(dir, "a.pdf"), join(dir, "nope.pdf")], {
    ignoreErrors: true,
  })
  expect(result.succeeded).toHaveLength(1)
  expect(result.failed).toHaveLength(1)
  expect(result.failed[0]?.source).toContain("nope.pdf")
  expect(result.ok).toBe(false)
})

test("a File with neither path nor blob is rejected", async () => {
  const { ws } = workspace(() => accepted(1))
  await expect(ws.ingestMany([new File({})])).rejects.toThrow(/no path and no blob/)
})

// --- globbing ---------------------------------------------------------------

test("a glob pattern expands to its matching files", async () => {
  const { ws, count } = workspace((_r, n) => accepted(n))
  const result = await ws.ingestMany([join(dir, "*.pdf")])
  expect(count()).toBe(2)
  expect(result.succeeded).toHaveLength(2)
})

test("a zero-match glob is surfaced like a missing path", async () => {
  const { ws } = workspace(() => accepted(1))
  await expect(ws.ingestMany([join(dir, "*.docx")])).rejects.toThrow(/matched no file/)
})

test("overlapping patterns upload each file once", async () => {
  const { ws, count } = workspace((_r, n) => accepted(n))
  await ws.ingestMany([join(dir, "*.pdf"), join(dir, "a.pdf"), join(dir, "a*.pdf")])
  expect(count(), "deduped by resolved path").toBe(2)
})

test("a plain string with no glob characters stays literal", async () => {
  const { ws, count } = workspace((_r, n) => accepted(n))
  await ws.ingestMany([join(dir, "notes.txt")])
  expect(count()).toBe(1)
})

test("blob-backed Files need no filesystem at all", async () => {
  const { ws, count } = workspace((_r, n) => accepted(n))
  const result = await ws.ingestMany([
    new File({ blob: new Blob(["%PDF"]), filename: "memo.pdf" }),
  ])
  expect(count()).toBe(1)
  expect(result.succeeded).toHaveLength(1)
})

// --- upload behavior --------------------------------------------------------

test("every upload goes into this workspace", async () => {
  const seen: string[] = []
  const client = makeClient(async (request) => {
    seen.push((await request.formData()).get("workspace_id") as string)
    return accepted(1)
  })
  const ws = ActiveRecord.hydrate(Workspace, client, { id: 42, name: "Legal" })
  await ws.ingestMany([join(dir, "*.pdf")])
  expect(seen).toEqual(["42", "42"])
})

test("tags are assigned to every uploaded document", async () => {
  const seen: string[][] = []
  const client = makeClient(async (request) => {
    seen.push((await request.formData()).getAll("tags") as string[])
    return accepted(1)
  })
  const ws = ActiveRecord.hydrate(Workspace, client, { id: 42, name: "Legal" })
  await ws.ingestMany([join(dir, "*.pdf")], { tags: [1, 2] })
  expect(seen).toEqual([
    ["1", "2"],
    ["1", "2"],
  ])
})

test("without wait, an accepted upload already counts as succeeded", async () => {
  const { ws } = workspace((_r, n) => accepted(n))
  const result = await ws.ingestMany([join(dir, "*.pdf")])
  expect(result.succeeded.map((f) => f.status)).toEqual(["pending", "pending"])
})

test("with wait, only terminal-ok files count as succeeded", async () => {
  const { ws } = workspace((request, n) =>
    request.method === "POST" ? accepted(n) : json({ id: 1, status: "embedded" }),
  )
  const result = await ws.ingestMany([join(dir, "*.pdf")], { wait: true, pollMs: 0 })
  expect(result.succeeded.map((f) => f.status)).toEqual(["embedded", "embedded"])
})

test("the first upload error stops the batch and is thrown", async () => {
  const { ws } = workspace((request) =>
    request.method === "POST" && request.url.endsWith("/files")
      ? json({ detail: "quota exceeded" }, 403)
      : accepted(1),
  )
  await expect(ws.ingestMany([join(dir, "*.pdf")])).rejects.toThrow(/quota exceeded/)
})

test("with ignoreErrors an upload failure is collected and the batch continues", async () => {
  let n = 0
  const client = makeClient(() => {
    n += 1
    return n === 1 ? json({ detail: "boom" }, 500) : accepted(n)
  })
  const ws = ActiveRecord.hydrate(Workspace, client, { id: 42, name: "Legal" })
  const result = await ws.ingestMany([join(dir, "*.pdf")], {
    ignoreErrors: true,
    maxConcurrency: 1, // deterministic ordering, so exactly one fails
  })
  expect(result.succeeded).toHaveLength(1)
  expect(result.failed).toHaveLength(1)
  expect(result.failed[0]?.error.message).toContain("boom")
})

test("an ingestion failure records the File, an upload failure does not", async () => {
  const client = makeClient((request) =>
    request.method === "POST"
      ? accepted(1)
      : json({ id: 1, status: "parsing_failed", status_detail: "corrupt" }),
  )
  const ws = ActiveRecord.hydrate(Workspace, client, { id: 42, name: "Legal" })
  const result = await ws.ingestMany([join(dir, "a.pdf")], {
    wait: true,
    pollMs: 0,
    ignoreErrors: true,
  })
  expect(
    result.failed[0]?.file,
    "a failure at ingestion carries its File",
  ).toBeDefined()
  expect(result.failed[0]?.error.message).toContain("corrupt")
})

test("concurrency is bounded by maxConcurrency", async () => {
  let inFlight = 0
  let peak = 0
  const client = makeClient(async () => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 5))
    inFlight -= 1
    return accepted(1)
  })
  const ws = ActiveRecord.hydrate(Workspace, client, { id: 42, name: "Legal" })
  await ws.ingestMany([join(dir, "*.pdf"), join(dir, "notes.txt")], {
    maxConcurrency: 2,
  })
  expect(peak).toBeLessThanOrEqual(2)
})

// --- async mode -------------------------------------------------------------

test("async mode returns a job you can poll", async () => {
  const { ws } = workspace((_r, n) => accepted(n))
  const job = await ws.ingestMany([join(dir, "*.pdf")], { mode: ExecMode.async })

  const started = job.poll()
  expect(started.total).toBe(2)

  const result = await job.wait()
  expect(job.done).toBe(true)
  expect(result.succeeded).toHaveLength(2)
  expect(job.progress).toEqual({
    total: 2,
    uploaded: 2,
    ingested: 0, // no ingestion wait was requested
    failed: 0,
    done: true,
  })
})

test("an async job reports ingested counts when waiting", async () => {
  const { ws } = workspace((request, n) =>
    request.method === "POST" ? accepted(n) : json({ id: 1, status: "embedded" }),
  )
  const job = await ws.ingestMany([join(dir, "*.pdf")], {
    mode: ExecMode.async,
    wait: true,
    pollMs: 0,
  })
  await job.wait()
  expect(job.progress.ingested).toBe(2)
  expect(job.result.ok).toBe(true)
})

test("an async failure surfaces on wait, not as an unhandled rejection", async () => {
  const { ws } = workspace(() => json({ detail: "quota exceeded" }, 403))
  const job = await ws.ingestMany([join(dir, "a.pdf")], { mode: ExecMode.async })
  await expect(job.wait()).rejects.toThrow(/quota exceeded/)
  expect(job.done).toBe(true)
})

test("wait times out rather than hanging on a stuck batch", async () => {
  const client = makeClient(
    () => new Promise<Response>(() => {}), // never settles
    { retries: 0 },
  )
  const ws = ActiveRecord.hydrate(Workspace, client, { id: 42, name: "Legal" })
  const job = await ws.ingestMany([join(dir, "a.pdf")], { mode: ExecMode.async })
  await expect(job.wait({ timeoutMs: 20 })).rejects.toThrow(/did not finish in time/)
})

test("prefailed items are counted in the job's total from the start", async () => {
  const { ws } = workspace((_r, n) => accepted(n))
  const job = await ws.ingestMany([join(dir, "a.pdf"), join(dir, "nope.pdf")], {
    mode: ExecMode.async,
    ignoreErrors: true,
  })
  expect(job.poll().total).toBe(2)
  expect(job.failed).toHaveLength(1)
  await job.wait()
  expect(job.progress).toMatchObject({ total: 2, uploaded: 1, failed: 1, done: true })
})
