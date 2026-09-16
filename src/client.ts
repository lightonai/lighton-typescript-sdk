/**
 * The LightOn API client.
 *
 * This module holds only the transport core (auth, request, stream, lifecycle). The four
 * primary verbs are attached from src/verbs/; CRUD-style groups hang off the
 * active-record resources instead.
 */

import {
  fromResponse,
  LightOnConnectionError,
  MalformedResponseError,
  RateLimitError,
} from "./errors.ts"
import type { ExtractJob, ParseJob } from "./job.ts"
import type { SchemaInput } from "./schema.ts"
import { DEFAULT_BASE_URL, type LightOnConfiguration } from "./types/config.ts"
import type { AskEvent } from "./types/events.ts"
import type {
  AskResponse,
  ExtractJobResponse,
  ParseResponse,
  SearchResponse,
} from "./types/index.ts"
import { camelize } from "./utils.ts"
import { type AskOptions, ask } from "./verbs/ask.ts"
import {
  type ExtractAsyncOptions,
  type ExtractOptions,
  extract,
} from "./verbs/extract.ts"
import { type ParseAsyncOptions, type ParseOptions, parse } from "./verbs/parse.ts"
import { type SearchOptions, search } from "./verbs/search.ts"

/** Query-string values, before URLSearchParams encoding. */
export type QueryValue = string | number | boolean | null | undefined
export type Query = Record<string, QueryValue | readonly QueryValue[]>

export interface RequestOptions {
  /** Sent as a JSON body. Mutually exclusive with `body`. */
  json?: unknown
  /** Sent as-is. Use a `FormData` for multipart, a `URLSearchParams` for a form body. */
  body?: BodyInit
  /** Query parameters. Nullish entries are dropped, arrays repeat the key. */
  params?: Query
  /**
   * Return the raw body as bytes instead of parsing JSON, for the endpoints that serve
   * a file (download/thumbnail). Errors are still JSON and still mapped to exceptions,
   * which is the whole reason this is a flag here rather than a second helper.
   */
  raw?: boolean
  /** Caller cancellation, merged with the client's timeout and lifetime. */
  signal?: AbortSignal
}

/**
 * The client surface the verbs and resources call.
 *
 * @internal
 */
export interface Transport {
  request<T>(method: string, path: string, options?: RequestOptions): Promise<T>
  stream(
    method: string,
    path: string,
    options?: RequestOptions,
  ): AsyncGenerator<string, void, undefined>
}

const sleep = (seconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000))

/**
 * Minimum-interval pacer to hold a per-minute request ceiling.
 *
 * ponytail: even spacing, not a burst-allowing token bucket, the simplest thing that
 * keeps concurrent callers under a per-minute cap. Swap for a token bucket if short
 * bursts need to be allowed. Clock and sleep are injectable so tests need no wall time.
 *
 * No lock, unlike the Python original: nothing awaits between reading and writing
 * `#next`, so the reservation is already atomic on a single-threaded runtime.
 *
 * @internal
 */
export class RateGate {
  readonly #interval: number
  readonly #sleep: (seconds: number) => Promise<void>
  readonly #now: () => number
  #next = 0

  constructor(
    perMinute: number,
    options: {
      sleep?: (seconds: number) => Promise<void>
      now?: () => number
    } = {},
  ) {
    this.#interval = 60 / perMinute
    this.#sleep = options.sleep ?? sleep
    this.#now = options.now ?? (() => performance.now() / 1000)
  }

  /** Wait just long enough that requests stay spaced by the interval. */
  acquire(): Promise<void> {
    const now = this.#now()
    const wait = this.#next - now
    this.#next = Math.max(now, this.#next) + this.#interval
    return wait > 0 ? this.#sleep(wait) : Promise.resolve()
  }
}

/**
 * Seconds to wait before a 429 retry: honor `Retry-After`, else backoff with jitter.
 *
 * ponytail: exponential backoff capped at 60s with small jitter; good enough for a
 * rate-limit cooldown.
 *
 * @internal
 */
export function cooldown(retryAfter: number | null, attempt: number): number {
  if (retryAfter !== null) return retryAfter
  return Math.min(60, 2 ** attempt) + Math.random() * 0.5
}

/** Connection-retry backoff, mirroring what httpx's transport does for the Python SDK. */
function connectBackoff(attempt: number): number {
  return Math.min(10, 2 ** attempt * 0.5)
}

/**
 * Whether a rejection came from an `AbortSignal` rather than the network.
 *
 * Both names matter: a caller's `AbortController` rejects with `AbortError`, while
 * `AbortSignal.timeout` rejects with `TimeoutError`. Neither is a connect failure, so
 * neither is retried, which is also where httpx's `retries=` draws the line.
 */
function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  )
}

function readEnvApiKey(): string | undefined {
  // `process` is absent in browsers and most edge runtimes; the SDK still has to load.
  return typeof process !== "undefined" ? process.env?.LIGHTON_API_KEY : undefined
}

function buildQuery(params: Query): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item === null || item === undefined) continue
      search.append(key, String(item))
    }
  }
  const query = search.toString()
  return query ? `?${query}` : ""
}

export class LightOn implements Transport {
  readonly #fetch: typeof globalThis.fetch
  readonly #baseUrl: string
  readonly #apiKey: string
  readonly #timeout: number
  readonly #retries: number
  readonly #rateLimitRetries: number
  readonly #gate: RateGate | null
  readonly #lifetime = new AbortController()

  /**
   * @param apiKey - Falls back to `LIGHTON_API_KEY` in the environment.
   * @param config - Optional client knobs, see {@link LightOnConfiguration}.
   * @throws Error - If no API key is given and none is in the environment.
   */
  constructor(apiKey?: string, config: LightOnConfiguration = {}) {
    const key = apiKey ?? readEnvApiKey()
    if (!key) {
      throw new Error("apiKey is required (pass apiKey or set LIGHTON_API_KEY)")
    }
    this.#apiKey = key
    this.#baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
    this.#fetch = config.fetch ?? globalThis.fetch.bind(globalThis)
    this.#timeout = config.timeout ?? 120_000
    this.#retries = config.retries ?? 3
    this.#rateLimitRetries = config.rateLimitRetries ?? 3
    const perMinute =
      config.maxRequestsPerMinute === undefined ? 1000 : config.maxRequestsPerMinute
    this.#gate = perMinute ? new RateGate(perMinute) : null
  }

  // --- primary verbs ------------------------------------------------------
  // Thin delegates to src/verbs/, which hold the request shaping. Composition rather
  // than the Python SDK's mixins: same public surface, and this module stays transport.

  /** {@inheritDoc ask} */
  ask(query: string, options?: AskOptions & { stream?: false }): Promise<AskResponse>
  ask(
    query: string,
    options: AskOptions & { stream: true },
  ): AsyncGenerator<AskEvent, void, undefined>
  ask(
    query: string,
    options: AskOptions & { stream?: boolean } = {},
  ): Promise<AskResponse> | AsyncGenerator<AskEvent, void, undefined> {
    // The overloads above are the contract; this hands off to the same pair below.
    return options.stream
      ? ask(this, query, options as AskOptions & { stream: true })
      : ask(this, query, options as AskOptions & { stream?: false })
  }

  /** {@inheritDoc search} */
  search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    return search(this, query, options)
  }

  /** {@inheritDoc parse} */
  parse(options: ParseOptions & { mode?: "sync" }): Promise<ParseResponse>
  parse(options: ParseAsyncOptions): Promise<ParseJob>
  parse(options: ParseOptions & { mode?: string }): Promise<ParseResponse | ParseJob> {
    return parse(this, options as ParseAsyncOptions)
  }

  /** {@inheritDoc extract} */
  extract(
    schema: SchemaInput,
    options: ExtractOptions & { mode?: "sync" },
  ): Promise<ExtractJobResponse>
  extract(schema: SchemaInput, options: ExtractAsyncOptions): Promise<ExtractJob>
  extract(
    schema: SchemaInput,
    options: ExtractOptions & { mode?: string },
  ): Promise<ExtractJobResponse | ExtractJob> {
    return extract(this, schema, options as ExtractAsyncOptions)
  }

  /** Abort every in-flight request. The client is not reusable afterwards. */
  close(): void {
    this.#lifetime.abort(new Error("client closed"))
  }

  [Symbol.dispose](): void {
    this.close()
  }

  /**
   * Send a request, throw on error, return parsed JSON (or null for an empty 2xx).
   *
   * Paces requests under the configured per-minute cap and, on HTTP 429, waits the
   * `Retry-After` cooldown (or exponential backoff) and retries up to
   * `rateLimitRetries` times. All callers route through here, so both the cap and the
   * cooldown apply to every endpoint uniformly. Response keys are camelCased on the way
   * out.
   *
   * @param method - HTTP method.
   * @param path - Path under `baseUrl`, carrying the full `/api/v3/...`.
   * @param options - Body, query, and the `raw` flag. See {@link RequestOptions}.
   * @returns The parsed body, a `Uint8Array` when `raw`, or null for an empty 2xx.
   * @throws LightOnAPIError - Mapped from a non-2xx status.
   * @throws LightOnConnectionError - On transport failure.
   * @throws MalformedResponseError - On a 2xx body that is not JSON.
   * @internal
   */
  async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.#gate?.acquire()
      const response = await this.#send(method, path, options)
      if (response.ok) return (await this.#parse(response, options.raw)) as T

      const error = await fromResponse(response)
      if (error instanceof RateLimitError && attempt < this.#rateLimitRetries) {
        await sleep(cooldown(error.retryAfter, attempt))
        continue
      }
      throw error
    }
  }

  /**
   * Send a request and yield the response body line by line, unparsed.
   *
   * The streaming sibling of {@link request}, for `text/event-stream` endpoints whose
   * body must not be read whole. It keeps the same guarantees: the rate gate, JSON error
   * mapping, and the 429 cooldown retry. It cannot be a flag on `request` the way `raw`
   * is, because the response has to stay open for the caller to consume, which inverts
   * who controls the lifetime.
   *
   * Being an async generator, the request is sent on the **first iteration**, not when
   * this is called, so connection and HTTP errors surface there.
   *
   * @param method - HTTP method.
   * @param path - Path under `baseUrl`.
   * @param options - Body and query. See {@link RequestOptions}.
   * @yields Body lines, newline-stripped.
   * @internal
   */
  async *stream(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): AsyncGenerator<string, void, undefined> {
    for (let attempt = 0; ; attempt++) {
      await this.#gate?.acquire()
      const response = await this.#send(method, path, options)
      if (response.ok) {
        yield* readLines(response)
        return
      }
      // Error bodies are JSON even here; the response is consumed before mapping.
      const error = await fromResponse(response)
      if (error instanceof RateLimitError && attempt < this.#rateLimitRetries) {
        await sleep(cooldown(error.retryAfter, attempt))
        continue
      }
      throw error
    }
  }

  /** One HTTP round trip, with connection-level retries. Never inspects the status. */
  async #send(
    method: string,
    path: string,
    options: RequestOptions,
  ): Promise<Response> {
    // An absolute path is a pagination `next` link, which already carries its query.
    // httpx passes those through untouched and so must this, or the base would be
    // prepended to a complete URL.
    const base = /^https?:\/\//.test(path) ? path : `${this.#baseUrl}${path}`
    const url = `${base}${options.params ? buildQuery(options.params) : ""}`
    const headers: Record<string, string> = { Authorization: `Bearer ${this.#apiKey}` }
    let body = options.body
    if (options.json !== undefined) {
      headers["Content-Type"] = "application/json"
      body = JSON.stringify(options.json)
    }
    // close() can land while an earlier await was pending. Say so here rather than
    // handing `fetch` a signal that is already aborted and reading the fallout back.
    if (this.#lifetime.signal.aborted) {
      throw new LightOnConnectionError("client is closed")
    }

    for (let attempt = 0; ; attempt++) {
      const signals = [AbortSignal.timeout(this.#timeout), this.#lifetime.signal]
      if (options.signal) signals.push(options.signal)
      try {
        return await this.#fetch(url, {
          method,
          headers,
          body: body ?? null,
          signal: AbortSignal.any(signals),
        })
      } catch (error) {
        // The caller cancelled: their abort, their error, not a transport failure.
        if (options.signal?.aborted) throw error
        // A closed client is terminal, retrying it would just fail `retries` more times.
        if (this.#lifetime.signal.aborted) {
          throw new LightOnConnectionError("client is closed", { cause: error })
        }
        if (isAbortError(error) || attempt >= this.#retries) {
          throw new LightOnConnectionError(errorMessage(error), { cause: error })
        }
        await sleep(connectBackoff(attempt))
      }
    }
  }

  async #parse(response: Response, raw?: boolean): Promise<unknown> {
    if (raw) return new Uint8Array(await response.arrayBuffer())
    const text = await response.text()
    if (!text) return null
    try {
      return camelize(JSON.parse(text))
    } catch (error) {
      throw new MalformedResponseError(
        `expected JSON but got: ${JSON.stringify(text.slice(0, 200))}`,
        { cause: error },
      )
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Yield a response body line by line.
 *
 * `try/finally` plus `cancel()` is what makes closing the generator close the socket,
 * the way the Python SDK's `with client.stream(...)` block does.
 */
async function* readLines(response: Response): AsyncGenerator<string, void, undefined> {
  if (!response.body) return
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += value
      let index = buffer.indexOf("\n")
      while (index !== -1) {
        yield buffer.slice(0, index).replace(/\r$/, "")
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf("\n")
      }
    }
    if (buffer) yield buffer.replace(/\r$/, "")
  } finally {
    await reader.cancel().catch(() => {})
  }
}
