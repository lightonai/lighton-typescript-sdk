import { describe, expect, test } from "vitest"
import { StreamError } from "../src/errors.ts"
import type { AskEvent } from "../src/types/events.ts"
import { parseSse } from "../src/verbs/ask.ts"
import { json, makeClient } from "./helpers.ts"

const ANSWERED = { results: [], answer: "42" }

/** An SSE body, delivered as one chunk. */
function sse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

async function lines(...values: string[]): Promise<AsyncGenerator<string>> {
  async function* gen() {
    for (const value of values) yield value
  }
  return gen()
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of source) out.push(item)
  return out
}

test("returns the answer and its sources", async () => {
  const client = makeClient(() => json({ results: [{ chunk_id: "c" }], answer: "42" }))
  const response = await client.ask("what is it?")
  expect(response.answer).toBe("42")
  expect(response.results[0]?.chunkId).toBe("c")
})

test("sends a zod schema as a normalized response_format", async () => {
  const { z } = await import("zod")
  const Revenue = z.object({
    amount: z.number().describe("Revenue figure, in millions."),
    currency: z.string(),
    quarter: z.string().nullable(),
  })

  let body: Record<string, unknown> = {}
  const client = makeClient(async (request) => {
    body = (await request.json()) as Record<string, unknown>
    return json(ANSWERED)
  })
  await client.ask("q", { schema: Revenue })

  const format = body.response_format as Record<string, unknown>
  expect(format.$schema).toBe("https://json-schema.org/draft/2020-12/schema")
  expect(format.type).toBe("object")
  expect(JSON.stringify(format)).not.toContain("$ref")
})

test("accepts a plain json schema object too", async () => {
  let body: Record<string, unknown> = {}
  const client = makeClient(async (request) => {
    body = (await request.json()) as Record<string, unknown>
    return json(ANSWERED)
  })
  await client.ask("q", {
    schema: { type: "object", properties: { total: { type: "number" } } },
  })
  expect(body.response_format).toEqual({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { total: { type: "number" } },
  })
})

// --- streaming --------------------------------------------------------------

test("streams sources, then tokens, then done", async () => {
  const client = makeClient(() =>
    sse(
      'event: sources\ndata: {"results":[{"chunk_id":"c1"}]}\n\n' +
        'event: token\ndata: {"text":"4"}\n\n' +
        'event: token\ndata: {"text":"2"}\n\n' +
        "event: done\ndata: {}\n\n",
    ),
  )
  const events = await collect(client.ask("q", { stream: true }))
  expect(events.map((e) => e.type)).toEqual(["sources", "token", "token", "done"])

  const [sources] = events as [Extract<AskEvent, { type: "sources" }>]
  expect(sources.results[0]?.chunkId, "sse payloads are camelized too").toBe("c1")
  expect(
    events
      .filter((e): e is Extract<AskEvent, { type: "token" }> => e.type === "token")
      .map((e) => e.text)
      .join(""),
  ).toBe("42")
})

test("is lazy: nothing is sent until the first iteration", async () => {
  let calls = 0
  const client = makeClient(() => {
    calls += 1
    return sse("event: done\ndata: {}\n\n")
  })
  const stream = client.ask("q", { stream: true })
  expect(calls).toBe(0)
  await stream.next()
  expect(calls).toBe(1)
})

test("an error event throws instead of arriving as an event", async () => {
  // A truncated answer that looks finished is the worse failure.
  const client = makeClient(() =>
    sse('event: error\ndata: {"detail":"model exploded"}\n\n'),
  )
  const error = await collect(client.ask("q", { stream: true })).catch(
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(StreamError)
  expect((error as StreamError).message).toContain("model exploded")
  expect((error as StreamError).body).toEqual({ detail: "model exploded" })
})

test("an unknown event type is skipped, not an error", async () => {
  const client = makeClient(() =>
    sse(
      'event: something_new\ndata: {"x":1}\n\n' +
        'event: token\ndata: {"text":"hi"}\n\n' +
        "event: done\ndata: {}\n\n",
    ),
  )
  const events = await collect(client.ask("q", { stream: true }))
  expect(events.map((e) => e.type)).toEqual(["token", "done"])
})

test("streaming composes with a schema", async () => {
  let body: Record<string, unknown> = {}
  const client = makeClient(async (request) => {
    body = (await request.json()) as Record<string, unknown>
    return sse(
      'event: token\ndata: {"text":"{\\"a\\":1}"}\n\nevent: done\ndata: {}\n\n',
    )
  })
  const events = await collect(
    client.ask("q", { stream: true, schema: { type: "object" } }),
  )
  expect(body.stream).toBe(true)
  expect(body.response_format).toBeDefined()
  const text = events
    .filter((e): e is Extract<AskEvent, { type: "token" }> => e.type === "token")
    .map((e) => e.text)
    .join("")
  expect(JSON.parse(text)).toEqual({ a: 1 })
})

// --- the SSE parser ---------------------------------------------------------

describe("parseSse", () => {
  test("pairs event with data", async () => {
    expect(
      await collect(parseSse(await lines("event: token", "data: hi", ""))),
    ).toEqual([["token", "hi"]])
  })

  test("strips one optional leading space after the colon", async () => {
    expect(await collect(parseSse(await lines("data:hi", "")))).toEqual([
      ["message", "hi"],
    ])
    expect(await collect(parseSse(await lines("data:  hi", "")))).toEqual([
      ["message", " hi"],
    ])
  })

  test("accumulates multi-line data payloads", async () => {
    expect(await collect(parseSse(await lines("data: one", "data: two", "")))).toEqual([
      ["message", "one\ntwo"],
    ])
  })

  test("ignores comment lines, which is what heartbeats are", async () => {
    expect(
      await collect(parseSse(await lines(": keep-alive", "data: hi", ""))),
    ).toEqual([["message", "hi"]])
  })

  test("skips unknown fields", async () => {
    expect(
      await collect(parseSse(await lines("id: 7", "retry: 500", "data: hi", ""))),
    ).toEqual([["message", "hi"]])
  })

  test("defaults a block with no event to `message`", async () => {
    expect(await collect(parseSse(await lines("data: hi", "")))).toEqual([
      ["message", "hi"],
    ])
  })

  test("dispatches a stream that ended without a trailing blank line", async () => {
    expect(await collect(parseSse(await lines("event: done", "data: {}")))).toEqual([
      ["done", "{}"],
    ])
  })

  test("resets the event name between blocks", async () => {
    expect(
      await collect(
        parseSse(await lines("event: token", "data: a", "", "data: b", "")),
      ),
    ).toEqual([
      ["token", "a"],
      ["message", "b"],
    ])
  })

  test("emits nothing for a blank line with no accumulated data", async () => {
    expect(await collect(parseSse(await lines("", "", "")))).toEqual([])
  })
})
