import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeAll, expect, test } from "vitest"
import { ExecMode } from "../src/enums.ts"
import { ExtractJob } from "../src/job.ts"
import { json, makeClient } from "./helpers.ts"

const EXTRACTED = {
  id: "e1",
  status: "completed",
  completed_at: "2026-09-16T00:00:05Z",
  processing_time_ms: 900,
  result: { data: [{ last_name: "Curie", first_name: "Marie" }] },
}

const SCHEMA = { type: "object", properties: { total: { type: "number" } } }

/** The `properties` of a schema that just went out on the wire. */
function propertiesOf(schema: unknown): Record<string, unknown> {
  return (schema as { properties: Record<string, unknown> }).properties
}

let pdfPath: string

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "lighton-"))
  pdfPath = join(dir, "invoice.pdf")
  await writeFile(pdfPath, "%PDF fake")
})

test("requires exactly one source", async () => {
  const client = makeClient(() => json(EXTRACTED))
  await expect(client.extract(SCHEMA, {})).rejects.toThrow(/exactly one of/)
  await expect(
    client.extract(SCHEMA, { url: "https://x/a.pdf", ingested: 7 }),
  ).rejects.toThrow(/exactly one of/)
})

test("targets an already-ingested file by id, with no re-upload", async () => {
  let body: Record<string, unknown> = {}
  const client = makeClient(async (request) => {
    body = (await request.json()) as Record<string, unknown>
    return json(EXTRACTED)
  })
  await client.extract(SCHEMA, { ingested: 7 })
  expect(body.file_id).toBe(7)
  expect(body.document).toBeUndefined()
})

test("accepts a File object in place of its id", async () => {
  let body: Record<string, unknown> = {}
  const client = makeClient(async (request) => {
    body = (await request.json()) as Record<string, unknown>
    return json(EXTRACTED)
  })
  await client.extract(SCHEMA, { ingested: { id: 12 } })
  expect(body.file_id).toBe(12)
})

test("leaves extracted rows in the caller's own schema shape", async () => {
  // The rows follow the schema the caller wrote, so renaming their keys would corrupt
  // the result. This is the reason `data` is an opaque key in camelize().
  const client = makeClient(() => json(EXTRACTED))
  const response = await client.extract(SCHEMA, { ingested: 7 })
  expect(response.processingTimeMs, "the envelope is still camelized").toBe(900)
  expect(response.result?.data).toEqual([{ last_name: "Curie", first_name: "Marie" }])
})

test("inlines $defs so the endpoint never sees a $ref", async () => {
  const { z } = await import("zod")
  const Person = z.object({ name: z.string() })
  const Letter = z.object({ sender: Person, recipient: Person })

  let body: Record<string, unknown> = {}
  const client = makeClient(async (request) => {
    body = (await request.json()) as Record<string, unknown>
    return json(EXTRACTED)
  })
  await client.extract(Letter, { ingested: 7 })

  const schema = JSON.stringify(body.schema)
  expect(schema, "vLLM rejects $ref").not.toContain("$ref")
  expect(schema).not.toContain("$defs")
  const properties = propertiesOf(body.schema)
  expect((properties.sender as Record<string, unknown>).type).toBe("object")
})

test("collapses a nullable anyOf into a type array", async () => {
  let body: Record<string, unknown> = {}
  const client = makeClient(async (request) => {
    body = (await request.json()) as Record<string, unknown>
    return json(EXTRACTED)
  })
  await client.extract(
    {
      type: "object",
      properties: { quarter: { anyOf: [{ type: "string" }, { type: "null" }] } },
    },
    { ingested: 7 },
  )
  expect(propertiesOf(body.schema).quarter).toEqual({ type: ["string", "null"] })
})

test("leaves an anyOf alone when a branch carries more than a type", async () => {
  let body: Record<string, unknown> = {}
  const client = makeClient(async (request) => {
    body = (await request.json()) as Record<string, unknown>
    return json(EXTRACTED)
  })
  await client.extract(
    {
      type: "object",
      properties: {
        when: { anyOf: [{ type: "string", format: "date" }, { type: "null" }] },
      },
    },
    { ingested: 7 },
  )
  expect(propertiesOf(body.schema).when).toHaveProperty("anyOf")
})

test("a dangling $ref throws client-side instead of 422ing at the API", async () => {
  const client = makeClient(() => json(EXTRACTED))
  await expect(
    client.extract(
      { type: "object", properties: { a: { $ref: "#/$defs/Missing" } } },
      { ingested: 7 },
    ),
  ).rejects.toThrow(/unresolved \$ref/)
})

test("rejects a schema that is neither zod nor a plain object", async () => {
  const client = makeClient(() => json(EXTRACTED))
  await expect(client.extract("nope" as never, { ingested: 7 })).rejects.toThrow(
    /must be a Zod schema or a plain JSON Schema object/,
  )
})

test("uploads a local path with schema and options as form fields", async () => {
  let form: FormData = new FormData()
  const client = makeClient(async (request) => {
    form = await request.formData()
    return json({ id: "e1", status: "pending" })
  })
  await client.extract(SCHEMA, { file: pdfPath, mode: ExecMode.async })

  expect((form.get("file") as File).name).toBe("invoice.pdf")
  expect(JSON.parse(form.get("schema") as string).type).toBe("object")
  expect(JSON.parse(form.get("options") as string)).toEqual({ async: true })
})

test("async mode returns a pollable job", async () => {
  const client = makeClient(() => json({ id: "e1", status: "pending" }))
  const job = await client.extract(SCHEMA, { ingested: 7, mode: ExecMode.async })
  expect(job).toBeInstanceOf(ExtractJob)
  expect(job.succeeded).toBe(false)
})

test("polling an extract job can request a page of results", async () => {
  const seen: string[] = []
  const client = makeClient((request) => {
    seen.push(request.url)
    return json({ id: "e1", status: "pending" })
  })
  const job = await client.extract(SCHEMA, { ingested: 7, mode: ExecMode.async })
  await job.poll({ page: 2 })
  expect(seen[1]).toContain("/api/v3/extract/e1?page=2")
})

test("caller options are merged with the async flag, not replaced", async () => {
  let body: Record<string, unknown> = {}
  const client = makeClient(async (request) => {
    body = (await request.json()) as Record<string, unknown>
    return json({ id: "e1", status: "pending" })
  })
  await client.extract(SCHEMA, {
    ingested: 7,
    mode: ExecMode.async,
    options: { hint: "invoice" },
  })
  expect(body.options).toEqual({ hint: "invoice", async: true })
})

test("a schema already converted by zod is not converted a second time", async () => {
  // Zod's own toJSONSchema() output carries a `~standard` marker with vendor "zod", so a
  // `~standard` check would send it back through the converter and throw inside zod.
  // Only `_zod` tells a live schema apart from a schema document.
  const { z } = await import("zod")
  const Person = z.object({ name: z.string() })
  const Pair = z.object({ left: Person, right: Person })
  const converted = z.toJSONSchema(Pair, {
    target: "draft-2020-12",
    io: "output",
    reused: "ref",
  })
  expect("$defs" in converted, "this case needs a schema that carries $defs").toBe(true)

  let body: Record<string, unknown> = {}
  const client = makeClient(async (request) => {
    body = (await request.json()) as Record<string, unknown>
    return json(EXTRACTED)
  })
  await client.extract(converted as Record<string, unknown>, { ingested: 7 })

  const sent = JSON.stringify(body.schema)
  expect(sent).not.toContain("$ref")
  expect(sent).not.toContain("$defs")
})

test("a Standard Schema from another library is rejected by name", async () => {
  const client = makeClient(() => json(EXTRACTED))
  const valibotish = {
    "~standard": { vendor: "valibot", version: 1, validate: () => ({ value: 1 }) },
  }
  await expect(client.extract(valibotish as never, { ingested: 7 })).rejects.toThrow(
    /unsupported schema library "valibot"/,
  )
})
