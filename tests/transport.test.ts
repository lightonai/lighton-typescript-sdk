/** What request() refuses: bounds, origins, redirects, plus Accept, raw keys and signals. */

import { expect, test, vi } from "vitest"
import { LightOn } from "../src/client.ts"
import * as exc from "../src/errors.ts"
import { File } from "../src/file.ts"
import { paginate } from "../src/utils.ts"
import { Workspace } from "../src/workspace.ts"
import { json, makeClient } from "./helpers.ts"

/** A body that streams `chunks` of `size` bytes and records whether it was cancelled. */
function streaming(chunks: number, size: number, headers: HeadersInit = {}) {
  const cancel = vi.fn()
  let sent = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent++ < chunks) controller.enqueue(new Uint8Array(size))
      else controller.close()
    },
    cancel,
  })
  return { cancel, response: new Response(body, { headers }) }
}

// --- headers and redirects ---------------------------------------------------------

test("sends lowercase header keys, Accept, and refuses redirects by default", async () => {
  let init: RequestInit | undefined
  const client = new LightOn("k", {
    maxRequestsPerMinute: null,
    fetch: (_input, options) => {
      init = options
      return Promise.resolve(json({ results: [] }))
    },
  })
  await client.request("POST", "/api/v3/search", { json: { query: "q" } })
  expect(init?.redirect).toBe("error")
  expect(init?.headers).toEqual({
    authorization: "Bearer k",
    accept: "application/json",
    "content-type": "application/json",
  })
})

test("raw requests accept anything unless told what to expect", async () => {
  const seen: (string | null)[] = []
  const client = makeClient((request) => {
    seen.push(request.headers.get("accept"))
    return new Response(new Uint8Array([1]))
  })
  await client.request("GET", "/x", { raw: true })
  await client.request("GET", "/x", { raw: true, accept: "application/pdf" })
  expect(seen).toEqual(["*/*", "application/pdf"])
})

test("redirect policy is configurable", async () => {
  let init: RequestInit | undefined
  const client = new LightOn("k", {
    maxRequestsPerMinute: null,
    redirect: "follow",
    fetch: (_input, options) => {
      init = options
      return Promise.resolve(json({}))
    },
  })
  await client.request("GET", "/x")
  expect(init?.redirect).toBe("follow")
})

// --- response keys -----------------------------------------------------------------

test("transformKeys: false hands back the wire's snake_case keys", async () => {
  const body = { total_pages: 2, workspace: { user_role: "admin" } }
  const client = makeClient(() => json(body), { transformKeys: false })
  expect(await client.request("GET", "/x")).toEqual(body)
  expect(await client.request("GET", "/x", { transformKeys: true })).toEqual({
    totalPages: 2,
    workspace: { userRole: "admin" },
  })
  const camel = makeClient(() => json(body))
  expect(await camel.request("GET", "/x", { transformKeys: false })).toEqual(body)
})

// --- size bound --------------------------------------------------------------------

test("no bound by default: a large body is read whole", async () => {
  const client = makeClient(() => streaming(4, 1024 * 1024).response)
  const bytes = await client.request<Uint8Array>("GET", "/x", { raw: true })
  expect(bytes.byteLength).toBe(4 * 1024 * 1024)
})

test("a declared Content-Length over the bound fails before the body is read", async () => {
  const { cancel, response } = streaming(1, 10, { "content-length": "2048" })
  const client = makeClient(() => response, { maxResponseBytes: 1024 })
  await expect(client.request("GET", "/x")).rejects.toBeInstanceOf(
    exc.ResponseTooLargeError,
  )
  expect(cancel).toHaveBeenCalledOnce()
})

test("an undeclared body is cancelled the moment it passes the bound", async () => {
  const { cancel, response } = streaming(100, 1024)
  const client = makeClient(() => response, { maxResponseBytes: 4096 })
  const error: unknown = await client
    .request("GET", "/x", { raw: true })
    .catch((e) => e)
  expect(error).toBeInstanceOf(exc.ResponseTooLargeError)
  expect((error as exc.ResponseTooLargeError).limit).toBe(4096)
  expect(cancel).toHaveBeenCalledOnce()
})

test("the bound is overridable per request, and a body under it is intact", async () => {
  const client = makeClient(() => json({ ok: true }), { maxResponseBytes: 2 })
  await expect(client.request("GET", "/x")).rejects.toBeInstanceOf(
    exc.ResponseTooLargeError,
  )
  expect(await client.request("GET", "/x", { maxResponseBytes: 1024 })).toEqual({
    ok: true,
  })
  expect(await client.request("GET", "/x", { maxResponseBytes: null })).toEqual({
    ok: true,
  })
})

test("a bounded chunked body is reassembled in order", async () => {
  const client = makeClient(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"a":'))
            controller.enqueue(new TextEncoder().encode("1}"))
            controller.close()
          },
        }),
      ),
    { maxResponseBytes: 1024 },
  )
  expect(await client.request("GET", "/x")).toEqual({ a: 1 })
})

// --- absolute URLs -----------------------------------------------------------------

test("an absolute URL on the client's origin is passed through untouched", async () => {
  const urls: string[] = []
  const client = makeClient((request) => {
    urls.push(request.url)
    return json({ results: [] })
  })
  await client.request("GET", "https://api.lighton.ai/api/v3/tags?page=2&name=x")
  expect(urls).toEqual(["https://api.lighton.ai/api/v3/tags?page=2&name=x"])
})

test.each([
  ["https://evil.example/api/v3/tags?page=2", /outside/],
  ["http://api.lighton.ai/api/v3/tags", /outside/], // scheme is part of the origin
  ["https://api.lighton.ai:8443/api/v3/tags", /outside/],
  ["https://k@api.lighton.ai/api/v3/tags", /credentials/],
  ["https://u:p@api.lighton.ai/api/v3/tags", /credentials/],
])("refuses to send the API key to %s", async (url, message) => {
  const fetch = vi.fn()
  const client = makeClient(fetch)
  await expect(client.request("GET", url)).rejects.toThrow(exc.UnsafeUrlError)
  await expect(client.request("GET", url)).rejects.toThrow(message)
  expect(fetch).not.toHaveBeenCalled()
})

test("a hostile pagination link stops a list() before any key leaks", async () => {
  const urls: string[] = []
  const client = makeClient((request) => {
    urls.push(request.url)
    return json({
      results: [{ id: 1, name: "A" }],
      next: "https://evil.example/api/v3/workspaces?page=2",
    })
  })
  await expect(Workspace.list(client)).rejects.toThrow(exc.UnsafeUrlError)
  expect(urls).toEqual(["https://api.lighton.ai/api/v3/workspaces"])
})

// --- pagination guards -------------------------------------------------------------

test("a pagination link that repeats fails instead of looping forever", async () => {
  const client = makeClient(() =>
    json({ results: [{ id: 1 }], next: "https://api.lighton.ai/api/v3/tags?page=2" }),
  )
  await expect(paginate(client, "/api/v3/tags")).rejects.toThrow(/loops back/)
})

test("the page ceiling stops an endless server", async () => {
  let page = 0
  const client = makeClient(() =>
    json({ results: [{ id: page }], next: `https://api.lighton.ai/t?page=${++page}` }),
  )
  await expect(paginate(client, "/t", undefined, { maxPages: 3 })).rejects.toThrow(
    /exceeded 3 pages/,
  )
  expect(page).toBe(3)
})

// --- signals on resources ----------------------------------------------------------

test("list(), get() and pages() forward a caller's signal", async () => {
  const controller = new AbortController()
  const signals: (AbortSignal | null | undefined)[] = []
  const client = new LightOn("k", {
    maxRequestsPerMinute: null,
    fetch: (_input, init) => {
      signals.push(init?.signal)
      return Promise.resolve(json({ id: 1, results: [{ id: 1 }], pages: [] }))
    },
  })
  await Workspace.list(client, { signal: controller.signal })
  const file = await File.get(client, 1, { signal: controller.signal })
  await file.pages({ signal: controller.signal })
  await file.refresh({ signal: controller.signal })
  expect(signals).toHaveLength(4)
  for (const signal of signals) expect(signal?.aborted).toBe(false)
  controller.abort()
  for (const signal of signals) expect(signal?.aborted).toBe(true)
})

test("an aborted signal stops a list() before the next page is requested", async () => {
  const controller = new AbortController()
  let calls = 0
  const client = makeClient((request) => {
    calls++
    controller.abort(new Error("caller gave up"))
    return json({ results: [], next: `${request.url}?page=2` })
  })
  await expect(Workspace.list(client, { signal: controller.signal })).rejects.toThrow(
    "caller gave up",
  )
  expect(calls).toBe(1)
})

test("stream() asks for an event stream, request() for JSON", async () => {
  const seen: (string | null)[] = []
  const client = makeClient((request) => {
    seen.push(request.headers.get("accept"))
    return new Response("data: {}\n\n")
  })
  for await (const _line of client.stream("POST", "/api/v3/ask", { json: {} })) {
    // drain
  }
  await client.request("POST", "/api/v3/ask", { json: {} }).catch(() => {})
  expect(seen).toEqual(["text/event-stream", "application/json"])
})

test("File.get can ask for the page text", async () => {
  const urls: string[] = []
  const client = makeClient((request) => {
    urls.push(request.url)
    return json({ id: 1, pages: [{ index: 1, markdown: "hi" }] })
  })
  await File.get(client, 1)
  await File.get(client, 1, { includeContent: true })
  expect(urls).toEqual([
    "https://api.lighton.ai/api/v3/files/1",
    "https://api.lighton.ai/api/v3/files/1?include_content=true",
  ])
})

// --- injected fetch errors ---------------------------------------------------------

test("an SDK error thrown by the injected fetch is rethrown, not wrapped", async () => {
  const inner = new exc.PermissionDeniedError("403", { statusCode: 403 })
  const client = makeClient(() => {
    throw inner
  })
  await expect(client.request("GET", "/x")).rejects.toBe(inner)
})

test("a plain error from fetch is still a connection error", async () => {
  const client = makeClient(
    () => {
      throw new TypeError("fetch failed")
    },
    { retries: 0 },
  )
  await expect(client.request("GET", "/x")).rejects.toBeInstanceOf(
    exc.LightOnConnectionError,
  )
})
