import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeAll, expect, test } from "vitest"
import { ExecMode } from "../src/enums.ts"
import { ParseJob } from "../src/job.ts"
import { json, makeClient } from "./helpers.ts"

const PARSED = {
  id: "p1",
  status: "completed",
  created_at: "2026-09-16T00:00:00Z",
  completed_at: "2026-09-16T00:00:05Z",
  processing_time_ms: 5000,
  document: { filename: "a.pdf" },
  result: { pages: [{ index: 0, markdown: "# Hi" }] },
  usage: { pages_processed: 1 },
}

let pdfPath: string

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "lighton-"))
  pdfPath = join(dir, "report.pdf")
  await writeFile(pdfPath, "%PDF fake")
})

test("requires exactly one of file or url", async () => {
  const client = makeClient(() => json(PARSED))
  await expect(client.parse({})).rejects.toThrow(/exactly one of 'file' or 'url'/)
  await expect(client.parse({ file: pdfPath, url: "https://x/a.pdf" })).rejects.toThrow(
    /exactly one of 'file' or 'url'/,
  )
})

test("parses a url as a json body", async () => {
  let body: Record<string, unknown> = {}
  const client = makeClient(async (request) => {
    body = (await request.json()) as Record<string, unknown>
    return json(PARSED)
  })
  const doc = await client.parse({ url: "https://example.com/report.pdf" })
  expect(body).toEqual({ document: "https://example.com/report.pdf" })
  expect(doc.result.pages[0]?.markdown).toBe("# Hi")
})

test("camelizes the response", async () => {
  const client = makeClient(() => json(PARSED))
  const doc = await client.parse({ url: "https://x/a.pdf" })
  expect(doc.processingTimeMs).toBe(5000)
  expect(doc.usage.pagesProcessed).toBe(1)
})

test("uploads a local path as multipart, under its basename", async () => {
  let contentType = ""
  let form: FormData = new FormData()
  const client = makeClient(async (request) => {
    contentType = request.headers.get("content-type") ?? ""
    form = await request.formData()
    return json(PARSED)
  })
  await client.parse({ file: pdfPath })

  expect(contentType).toContain("multipart/form-data")
  const file = form.get("file") as File
  expect(file.name).toBe("report.pdf")
  expect(await file.text()).toBe("%PDF fake")
  expect(form.get("options"), "sync mode sends no options").toBeNull()
})

test("accepts a Blob so runtimes without a filesystem still work", async () => {
  let form: FormData = new FormData()
  const client = makeClient(async (request) => {
    form = await request.formData()
    return json(PARSED)
  })
  await client.parse({ file: { filename: "memo.pdf", blob: new Blob(["%PDF"]) } })
  expect((form.get("file") as File).name).toBe("memo.pdf")
})

test("a bare Blob with no filename is rejected at the call site", async () => {
  const client = makeClient(() => json(PARSED))
  await expect(client.parse({ file: new Blob(["%PDF"]) as never })).rejects.toThrow(
    /needs a filename/,
  )
})

// --- async mode -------------------------------------------------------------

test("async mode returns a pollable job and sends the async option", async () => {
  let form: FormData = new FormData()
  const client = makeClient(async (request) => {
    form = await request.formData()
    return json({ id: "p1", status: "pending" })
  })
  const job = await client.parse({ file: pdfPath, mode: ExecMode.async })

  expect(job).toBeInstanceOf(ParseJob)
  expect(job.id).toBe("p1")
  expect(job.done, "a pending job has no completedAt").toBe(false)
  expect(JSON.parse(form.get("options") as string)).toEqual({ async: true })
})

test("async mode over a url sends options in the json body", async () => {
  let body: Record<string, unknown> = {}
  const client = makeClient(async (request) => {
    body = (await request.json()) as Record<string, unknown>
    return json({ id: "p1", status: "pending" })
  })
  await client.parse({ url: "https://x/a.pdf", mode: ExecMode.async })
  expect(body).toEqual({ document: "https://x/a.pdf", options: { async: true } })
})

test("wait without async mode is rejected, inline already blocks", async () => {
  const client = makeClient(() => json(PARSED))
  await expect(
    client.parse({ url: "https://x/a.pdf", wait: true } as never),
  ).rejects.toThrow(/wait is only meaningful/)
})

test("polling updates the job in place and reports terminal state", async () => {
  let calls = 0
  const client = makeClient(() => {
    calls += 1
    return calls === 1 ? json({ id: "p1", status: "pending" }) : json(PARSED)
  })
  const job = await client.parse({ url: "https://x/a.pdf", mode: ExecMode.async })
  expect(job.succeeded).toBe(false)

  await job.poll()
  expect(job.succeeded).toBe(true)
  expect(job.done).toBe(true)
  expect(job.result?.pages[0]?.markdown).toBe("# Hi")
})

test("wait: true returns a job that already carries its result", async () => {
  let calls = 0
  const client = makeClient(() => {
    calls += 1
    return calls === 1 ? json({ id: "p1", status: "pending" }) : json(PARSED)
  })
  const job = await client.parse({
    url: "https://x/a.pdf",
    mode: ExecMode.async,
    wait: true,
  })
  expect(job.succeeded).toBe(true)
  expect(job.result?.pages).toHaveLength(1)
})

test("a job that ends without succeeding throws, carrying the error block", async () => {
  let calls = 0
  const client = makeClient(() => {
    calls += 1
    return calls === 1
      ? json({ id: "p1", status: "pending" })
      : json({
          id: "p1",
          status: "failed",
          completed_at: "2026-09-16T00:00:05Z",
          error: { message: "unreadable scan" },
        })
  })
  const job = await client.parse({ url: "https://x/a.pdf", mode: ExecMode.async })
  await expect(job.wait({ pollMs: 0 })).rejects.toThrow(/unreadable scan/)
})

test("grounding sends the option and returns page blocks", async () => {
  const sent: Request[] = []
  const block = {
    type: "title",
    top_left_x: 100,
    top_left_y: 50,
    bottom_right_x: 900,
    bottom_right_y: 90,
    content: "# Report",
  }
  const client = makeClient((request) => {
    sent.push(request)
    return json({
      ...PARSED,
      result: { pages: [{ index: 1, markdown: "# Report", blocks: [block] }] },
    })
  })

  const doc = await client.parse({ url: "https://example.com/d.pdf", grounding: true })
  expect(await sent[0]?.json()).toEqual({
    document: "https://example.com/d.pdf",
    options: { grounding: true },
  })
  const [page] = doc.result.pages
  expect(page?.blocks?.[0]?.type).toBe("title")
  expect(page?.blocks?.[0]?.bottomRightX).toBe(900)

  // multipart: same options, JSON-encoded as a form field, composed with async
  await client.parse({ file: pdfPath, grounding: true, mode: ExecMode.async })
  const form = await sent[1]?.formData()
  expect(JSON.parse(String(form?.get("options")))).toEqual({
    async: true,
    grounding: true,
  })
})

test("no options field is sent when nothing asks for one", async () => {
  let body: Record<string, unknown> = {}
  const client = makeClient(async (request) => {
    body = (await request.json()) as Record<string, unknown>
    return json(PARSED)
  })
  await client.parse({ url: "https://x/a.pdf", grounding: false })
  expect(body).toEqual({ document: "https://x/a.pdf" })
})
