/**
 * LightOn client core: auth, error mapping, transport, against an injected fetch.
 *
 * Per-verb request/response tests live alongside the verbs.
 */

import { afterEach, describe, expect, test, vi } from "vitest"
import { cooldown, LightOn, RateGate } from "../src/client.ts"
import * as exc from "../src/errors.ts"
import type { LightOnConfiguration } from "../src/types/config.ts"

type Handler = (request: Request) => Response | Promise<Response>

/**
 * rateLimitRetries 0 so mapping tests see the single-shot response; pacing off so tests
 * don't wait on the gate (its behavior is covered by the RateGate tests). Both are
 * overridable by the retry-behavior tests below.
 */
function makeClient(handler: Handler, config: LightOnConfiguration = {}): LightOn {
  return new LightOn("k", {
    rateLimitRetries: 0,
    maxRequestsPerMinute: null,
    fetch: (input, init) => Promise.resolve(handler(new Request(input, init))),
    ...config,
  })
}

/**
 * A fetch that never resolves on its own, but rejects when its signal aborts, the way a
 * real one does. Without the abort wiring, a fake fetch silently hides whether the
 * client's timeout and `close()` actually reach the request.
 */
function hangingFetch(): typeof globalThis.fetch {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (!signal) return
      const fail = () =>
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException("aborted", "AbortError"),
        )
      // Real fetch rejects straight away when handed an already-aborted signal.
      if (signal.aborted) fail()
      else signal.addEventListener("abort", fail)
    })
}

const json = (status: number, body: unknown, headers?: HeadersInit): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })

afterEach(() => {
  delete process.env.LIGHTON_API_KEY
  vi.restoreAllMocks()
})

test("requires an api key", () => {
  delete process.env.LIGHTON_API_KEY
  expect(() => new LightOn()).toThrow(/apiKey is required/)
})

test("reads the api key from the environment", async () => {
  process.env.LIGHTON_API_KEY = "envkey"
  let auth: string | null = null
  const client = new LightOn(undefined, {
    maxRequestsPerMinute: null,
    fetch: (input, init) => {
      auth = new Request(input, init).headers.get("authorization")
      return Promise.resolve(json(200, { results: [], answer: "" }))
    },
  })
  await client.request("POST", "/api/v3/ask", { json: { query: "q" } })
  expect(auth).toBe("Bearer envkey")
})

test("strips a trailing slash from the base url", async () => {
  let url = ""
  const client = makeClient(
    (request) => {
      url = request.url
      return json(200, {})
    },
    { baseUrl: "https://lighton.internal.acme.com/" },
  )
  await client.request("GET", "/api/v3/workspaces")
  expect(url).toBe("https://lighton.internal.acme.com/api/v3/workspaces")
})

describe("error mapping", () => {
  const cases: [number, new (...args: never[]) => exc.LightOnAPIError][] = [
    [401, exc.AuthenticationError],
    [403, exc.PermissionDeniedError],
    [404, exc.NotFoundError],
    [429, exc.RateLimitError],
    [500, exc.ServerError],
    [503, exc.ServerError],
    [418, exc.LightOnAPIError], // unmapped 4xx -> base API error
  ]

  test.each(cases)("%i maps to its own class", async (status, expected) => {
    const client = makeClient(() => json(status, { detail: "nope" }))
    const error = await client.request("GET", "/x").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(expected)
    expect((error as { constructor: unknown }).constructor).toBe(expected)
    expect((error as exc.LightOnAPIError).statusCode).toBe(status)
  })
})

test("rate limit exposes retry-after", async () => {
  const client = makeClient(() =>
    json(429, { detail: "slow down" }, { "Retry-After": "30" }),
  )
  const error = (await client
    .request("GET", "/x")
    .catch((e: unknown) => e)) as exc.RateLimitError
  expect(error).toBeInstanceOf(exc.RateLimitError)
  expect(error.retryAfter).toBe(30)
})

test("rate limit without the header has a null retry-after", async () => {
  const client = makeClient(() => json(429, { detail: "slow down" }))
  const error = (await client
    .request("GET", "/x")
    .catch((e: unknown) => e)) as exc.RateLimitError
  expect(error.retryAfter).toBeNull()
})

test("an empty 2xx returns null", async () => {
  const client = makeClient(() => new Response(null, { status: 204 }))
  await expect(client.request("DELETE", "/x")).resolves.toBeNull()
})

test("malformed json on a 2xx throws", async () => {
  const client = makeClient(() => new Response("not json", { status: 200 }))
  await expect(client.request("GET", "/x")).rejects.toBeInstanceOf(
    exc.MalformedResponseError,
  )
})

test("a transport error is wrapped", async () => {
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

test("close aborts in-flight requests and is not retried", async () => {
  // retries: 3 on purpose. A closed client is terminal, so it must fail at once rather
  // than burn the connection-retry budget on a signal that will never un-abort.
  const client = new LightOn("k", {
    maxRequestsPerMinute: null,
    retries: 3,
    fetch: hangingFetch(),
  })
  const pending = client.request("GET", "/x")
  client.close()
  await expect(pending).rejects.toThrow(/client is closed/)
})

test("Symbol.dispose closes the client", async () => {
  const client = new LightOn("k", {
    maxRequestsPerMinute: null,
    fetch: hangingFetch(),
  })
  const pending = client.request("GET", "/x")
  client[Symbol.dispose]()
  await expect(pending).rejects.toBeInstanceOf(exc.LightOnConnectionError)
})

test("a caller's own abort is rethrown untouched, not wrapped", async () => {
  const controller = new AbortController()
  const client = new LightOn("k", {
    maxRequestsPerMinute: null,
    fetch: hangingFetch(),
  })
  const pending = client.request("GET", "/x", { signal: controller.signal })
  const cancelled = new Error("caller cancelled")
  controller.abort(cancelled)
  await expect(pending).rejects.toBe(cancelled)
})

test("a timeout is not retried as if it were a connect failure", async () => {
  // AbortSignal.timeout rejects with a TimeoutError, not an AbortError. Treating that
  // as retryable would multiply the caller's deadline by `retries`.
  let calls = 0
  const client = new LightOn("k", {
    maxRequestsPerMinute: null,
    retries: 3,
    timeout: 20,
    fetch: (input, init) => {
      calls += 1
      return hangingFetch()(input, init)
    },
  })
  await expect(client.request("GET", "/x")).rejects.toBeInstanceOf(
    exc.LightOnConnectionError,
  )
  expect(calls).toBe(1)
})

test("query params drop nullish entries and repeat arrays", async () => {
  let url = ""
  const client = makeClient((request) => {
    url = request.url
    return json(200, {})
  })
  await client.request("GET", "/x", {
    params: { workspace_id: [1, 2], title: "a b", missing: null, off: false },
  })
  expect(url).toContain("workspace_id=1&workspace_id=2")
  expect(url).toContain("title=a+b")
  expect(url).toContain("off=false")
  expect(url).not.toContain("missing")
})

// --- rate-limit retry + pacing ---------------------------------------------

test("a 429 is retried, then succeeds", async () => {
  let calls = 0
  const client = makeClient(
    () => {
      calls += 1
      return calls === 1
        ? json(429, {}, { "Retry-After": "0" })
        : json(200, { ok: true })
    },
    { rateLimitRetries: 2 },
  )
  await expect(client.request("GET", "/x")).resolves.toEqual({ ok: true })
  expect(calls).toBe(2) // one 429, then a successful retry
})

test("exhausted 429 retries throw", async () => {
  let calls = 0
  const client = makeClient(
    () => {
      calls += 1
      return json(429, { detail: "nope" }, { "Retry-After": "0" })
    },
    { rateLimitRetries: 2 },
  )
  await expect(client.request("GET", "/x")).rejects.toBeInstanceOf(exc.RateLimitError)
  expect(calls).toBe(3) // initial + 2 retries
})

test("a connection failure is retried up to `retries` times", async () => {
  let calls = 0
  const client = makeClient(
    () => {
      calls += 1
      if (calls <= 2) throw new TypeError("fetch failed")
      return json(200, { ok: true })
    },
    { retries: 2 },
  )
  await expect(client.request("GET", "/x")).resolves.toEqual({ ok: true })
  expect(calls).toBe(3)
})

describe("cooldown", () => {
  test("honors Retry-After when present", () => {
    expect(cooldown(30, 5)).toBe(30)
    expect(cooldown(0, 5)).toBe(0)
  })

  test("otherwise backs off exponentially, capped at 60s, with jitter", () => {
    vi.spyOn(Math, "random").mockReturnValue(0)
    expect(cooldown(null, 0)).toBe(1)
    expect(cooldown(null, 3)).toBe(8)
    expect(cooldown(null, 30)).toBe(60) // capped
    vi.spyOn(Math, "random").mockReturnValue(1)
    expect(cooldown(null, 0)).toBe(1.5) // jitter on top
  })
})

test("pacing is on by default and can be turned off", async () => {
  // Default: a gate is installed (1000/min for most endpoints), so a second immediate
  // request has to wait. With null, it does not.
  const paced = new LightOn("k", { fetch: () => Promise.resolve(json(200, {})) })
  const start = performance.now()
  await paced.request("GET", "/x")
  await paced.request("GET", "/x")
  expect(performance.now() - start).toBeGreaterThan(20) // 60/1000 = 60ms apart

  const unpaced = makeClient(() => json(200, {}))
  const quick = performance.now()
  await unpaced.request("GET", "/x")
  await unpaced.request("GET", "/x")
  expect(performance.now() - quick).toBeLessThan(20)
})

test("the rate gate paces requests", async () => {
  let now = 0
  const slept: number[] = []
  const gate = new RateGate(60, {
    // 1 req/s
    now: () => now,
    sleep: (seconds) => {
      slept.push(seconds)
      return Promise.resolve()
    },
  })

  await gate.acquire() // first call: nothing scheduled yet, no wait
  expect(slept).toEqual([])
  now = 0.1 // 0.1s elapsed, but the interval is 1.0s
  await gate.acquire()
  expect(slept.at(-1)).toBeCloseTo(0.9, 2)
})

// --- raw (binary) responses -------------------------------------------------
// The download/thumbnail endpoints serve files, not JSON. They stay on the one
// `request` so auth, error mapping, the 429 cooldown and the rate gate are shared;
// `raw` only skips the JSON parse.

test("raw returns bytes without parsing json", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const client = makeClient(() => new Response(png, { status: 200 }))
  const got = await client.request<Uint8Array>("GET", "/api/v3/files/7/download", {
    raw: true,
  })
  expect(got).toBeInstanceOf(Uint8Array)
  expect([...got]).toEqual([...png])
})

test("raw is what makes a binary body work", async () => {
  // Same body, parsed: the guarantee is that `raw` is what makes it work.
  const client = makeClient(() => new Response("%PDF-1.7 binary", { status: 200 }))
  await expect(
    client.request("GET", "/api/v3/files/7/download"),
  ).rejects.toBeInstanceOf(exc.MalformedResponseError)
})

test("raw still maps errors to exceptions", async () => {
  // Errors stay JSON even on a binary endpoint, and must still throw.
  const client = makeClient(() => json(404, { detail: "No thumbnail available" }))
  await expect(
    client.request("GET", "/api/v3/files/7/thumbnail", { raw: true }),
  ).rejects.toBeInstanceOf(exc.NotFoundError)
})

test("raw still retries a 429", async () => {
  let calls = 0
  const client = makeClient(
    () => {
      calls += 1
      return calls === 1
        ? json(429, { detail: "slow down" }, { "Retry-After": "0" })
        : new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200 })
    },
    { rateLimitRetries: 2 },
  )
  const got = await client.request<Uint8Array>("GET", "/api/v3/files/7/download", {
    raw: true,
  })
  expect([...got]).toEqual([0x25, 0x50, 0x44, 0x46])
  expect(calls, "the cooldown retry must cover binary endpoints too").toBe(2)
})

test("a raw empty body is empty bytes, not null", async () => {
  // The JSON path turns an empty 2xx into null; the bytes path must not.
  const client = makeClient(() => new Response(null, { status: 200 }))
  const got = await client.request<Uint8Array>("GET", "/api/v3/files/7/download", {
    raw: true,
  })
  expect(got).toBeInstanceOf(Uint8Array)
  expect(got.length).toBe(0)
})

// --- maintenance windows ----------------------------------------------------
// A 503 from the maintenance middleware is worth retrying later; a 503 from a crash is
// not. They arrive on the same status code, so the body tells them apart.

const MAINTENANCE_BODY = {
  detail: "System is under maintenance.",
  error: "service_maintenance",
  mode: "full_shutdown",
  reason: "database migration",
  started_at: "2026-09-15T08:30:00Z",
  endpoint_category_names: ["search", "ingestion"],
}

test("a maintenance 503 throws a dedicated error with its fields", async () => {
  const client = makeClient(() => json(503, MAINTENANCE_BODY))
  const error = (await client
    .request("GET", "/x")
    .catch((e: unknown) => e)) as exc.MaintenanceError

  expect(error).toBeInstanceOf(exc.MaintenanceError)
  expect(error.mode).toBe("full_shutdown")
  expect(error.reason).toBe("database migration")
  expect(error.startedAt?.getUTCFullYear()).toBe(2026)
  expect(error.endpointCategories).toEqual(["search", "ingestion"])
  expect(error.statusCode).toBe(503)
  expect(error.body).toEqual(MAINTENANCE_BODY) // the untouched payload is still there
  expect(error.message).toContain("System is under maintenance.")
})

test("a maintenance error is still a server error", async () => {
  // Subclassing keeps existing `instanceof ServerError` handlers working.
  const client = makeClient(() => json(503, MAINTENANCE_BODY))
  await expect(client.request("GET", "/x")).rejects.toBeInstanceOf(exc.ServerError)
  expect(exc.MaintenanceError.prototype).toBeInstanceOf(exc.ServerError)
})

test("a plain 503 stays a server error", async () => {
  const client = makeClient(() => json(503, { detail: "boom" }))
  const error = await client.request("GET", "/x").catch((e: unknown) => e)
  expect(
    (error as { constructor: unknown }).constructor,
    "a crash must not read as maintenance",
  ).toBe(exc.ServerError)
})

test("maintenance survives a missing or unparsable timestamp", async () => {
  const body = { detail: "down", error: "service_maintenance", mode: "warning_banner" }
  let client = makeClient(() => json(503, body))
  let error = (await client
    .request("GET", "/x")
    .catch((e: unknown) => e)) as exc.MaintenanceError
  expect(error.startedAt).toBeNull()
  expect(error.reason).toBeNull()
  expect(error.endpointCategories).toEqual([]) // empty means every endpoint

  client = makeClient(() => json(503, { ...body, started_at: "not a date" }))
  error = (await client
    .request("GET", "/x")
    .catch((e: unknown) => e)) as exc.MaintenanceError
  expect(error.startedAt).toBeNull()
  // raw value preserved
  expect((error.body as Record<string, unknown>).started_at).toBe("not a date")
})

test("maintenance is not retried like a 429", async () => {
  // 5xx is deliberately not retried: the window outlasts any cooldown we would wait.
  let calls = 0
  const client = makeClient(
    () => {
      calls += 1
      return json(503, MAINTENANCE_BODY)
    },
    { rateLimitRetries: 3 },
  )
  await expect(client.request("GET", "/x")).rejects.toBeInstanceOf(exc.MaintenanceError)
  expect(calls).toBe(1)
})

test("an absolute path is used as-is, so pagination `next` links work", async () => {
  // `next` comes back as a complete URL carrying its own query string. Prepending the
  // base to it would produce nonsense and silently truncate every list().
  const seen: string[] = []
  const client = makeClient((request) => {
    seen.push(request.url)
    return json(200, {})
  })
  await client.request("GET", "/api/v3/tags")
  await client.request("GET", "https://api.lighton.ai/api/v3/tags?page=2")
  expect(seen).toEqual([
    "https://api.lighton.ai/api/v3/tags",
    "https://api.lighton.ai/api/v3/tags?page=2",
  ])
})
