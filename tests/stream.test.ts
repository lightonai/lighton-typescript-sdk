/** `LightOn.stream`: the transport half of SSE. Event parsing lives with `ask`. */

import { expect, test } from "vitest"
import { LightOn } from "../src/client.ts"
import * as exc from "../src/errors.ts"
import type { LightOnConfiguration } from "../src/types/config.ts"

type Handler = () => Response | Promise<Response>

function makeClient(handler: Handler, config: LightOnConfiguration = {}): LightOn {
  return new LightOn("k", {
    rateLimitRetries: 0,
    maxRequestsPerMinute: null,
    fetch: () => Promise.resolve(handler()),
    ...config,
  })
}

/** A body delivered in the given chunks, so boundary handling is actually exercised. */
function chunked(...chunks: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }),
    { status: 200 },
  )
}

async function collect(lines: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = []
  for await (const line of lines) out.push(line)
  return out
}

test("yields the body line by line, newline-stripped", async () => {
  const client = makeClient(() => chunked("event: token\ndata: hi\n\n"))
  expect(await collect(client.stream("POST", "/api/v3/ask"))).toEqual([
    "event: token",
    "data: hi",
    "",
  ])
})

test("reassembles lines split across chunk boundaries", async () => {
  const client = makeClient(() => chunked("event: to", "ken\nda", "ta: hi\n"))
  expect(await collect(client.stream("POST", "/api/v3/ask"))).toEqual([
    "event: token",
    "data: hi",
  ])
})

test("yields a trailing line that has no newline after it", async () => {
  const client = makeClient(() => chunked("data: last"))
  expect(await collect(client.stream("POST", "/api/v3/ask"))).toEqual(["data: last"])
})

test("strips CR from CRLF line endings", async () => {
  const client = makeClient(() => chunked("data: a\r\ndata: b\r\n"))
  expect(await collect(client.stream("POST", "/api/v3/ask"))).toEqual([
    "data: a",
    "data: b",
  ])
})

test("is lazy: nothing is sent until the first iteration", async () => {
  let calls = 0
  const client = makeClient(() => {
    calls += 1
    return chunked("data: hi\n")
  })
  const stream = client.stream("POST", "/api/v3/ask")
  expect(calls, "creating the generator must not send the request").toBe(0)
  await stream.next()
  expect(calls).toBe(1)
})

test("maps http errors on the first step, not at the call", async () => {
  const client = makeClient(
    () =>
      new Response(JSON.stringify({ detail: "bad query" }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      }),
  )
  const stream = client.stream("POST", "/api/v3/ask")
  await expect(stream.next()).rejects.toBeInstanceOf(exc.LightOnAPIError)
})

test("still retries a 429", async () => {
  let calls = 0
  const client = makeClient(
    () => {
      calls += 1
      return calls === 1
        ? new Response("{}", { status: 429, headers: { "Retry-After": "0" } })
        : chunked("data: hi\n")
    },
    { rateLimitRetries: 2 },
  )
  expect(await collect(client.stream("POST", "/api/v3/ask"))).toEqual(["data: hi"])
  expect(calls).toBe(2)
})

test("closing early releases the underlying stream", async () => {
  let cancelled = false
  const client = makeClient(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: a\ndata: b\n"))
          },
          cancel() {
            cancelled = true
          },
        }),
        { status: 200 },
      ),
  )
  const stream = client.stream("POST", "/api/v3/ask")
  expect((await stream.next()).value).toBe("data: a")
  await stream.return(undefined) // what `break` out of a for-await does
  expect(cancelled, "abandoning the generator must close the connection").toBe(true)
})
