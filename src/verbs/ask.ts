/** `ask`: grounded question answering over indexed documents. */

import type { Transport } from "../client.ts"
import type { RelevanceScoring } from "../enums.ts"
import { StreamError } from "../errors.ts"
import { asJsonSchema, type SchemaInput } from "../schema.ts"
import type { AskEvent } from "../types/events.ts"
import type { AskResponse, AskResultItem } from "../types/index.ts"
import { camelize, compact } from "../utils.ts"
import { type ScopeOptions, scopeBody } from "./scope.ts"

const ASK_PATH = "/api/v3/ask"

export interface AskOptions extends ScopeOptions {
  /** Chunks to retrieve for context (1 to 50; server default 10). */
  maxResults?: number
  /** Defaults to `scoringAndFiltering` server-side. */
  relevanceScoring?: RelevanceScoring
  /** LLM for answer generation; platform default if omitted. */
  model?: string
  /**
   * Constrain the answer to structured output: a Zod schema or a plain JSON Schema
   * object (the same inputs `extract` takes, sent as the API's `response_format`; it
   * must describe an object).
   *
   * The answer then comes back as JSON *text* in `.answer`. The SDK does not parse it
   * back for you, so that a schema mismatch surfaces where you can see it.
   */
  schema?: SchemaInput
}

/**
 * Parse an SSE byte stream into `[event, data]` pairs.
 *
 * Handles what the spec requires of a consumer here: `event:`/`data:` fields, an
 * optional single leading space after the colon, `data:` lines accumulating across a
 * multi-line payload, a blank line dispatching the event, and `:` comment lines
 * (heartbeats) ignored. Unknown fields are skipped, and a block with no `event:`
 * defaults to `message`, as the spec says.
 *
 * ponytail: no `id:`/`retry:` handling and no reconnection, because this stream is
 * one-shot and the API sends neither. Add them if resumable streams appear.
 *
 * @internal
 */
export async function* parseSse(
  lines: AsyncIterable<string>,
): AsyncGenerator<[string, string], void, undefined> {
  let event = ""
  let data: string[] = []
  for await (const line of lines) {
    if (!line) {
      // A blank line dispatches whatever has accumulated.
      if (data.length > 0) yield [event || "message", data.join("\n")]
      event = ""
      data = []
    } else if (line.startsWith(":")) {
      // Comment / heartbeat.
    } else if (line.includes(":")) {
      const colon = line.indexOf(":")
      const field = line.slice(0, colon)
      let value = line.slice(colon + 1)
      if (value.startsWith(" ")) value = value.slice(1)
      if (field === "event") event = value
      else if (field === "data") data.push(value)
    }
  }
  // A stream that ended without a trailing blank line.
  if (data.length > 0) yield [event || "message", data.join("\n")]
}

async function askBody(
  transport: Transport,
  query: string,
  options: AskOptions,
): Promise<Record<string, unknown>> {
  return {
    query,
    ...(await scopeBody(transport, options)),
    ...compact({
      max_results: options.maxResults,
      relevance_scoring: options.relevanceScoring,
      model: options.model,
      response_format: options.schema ? await asJsonSchema(options.schema) : undefined,
    }),
  }
}

/**
 * `POST /api/v3/ask`, ask a grounded question over indexed documents.
 *
 * With `stream: true` this returns an async iterable of {@link AskEvent} instead of the
 * whole answer: `SourcesEvent` once before generation, `TokenEvent` repeatedly, then
 * `DoneEvent`. Being a generator, nothing is sent until you start iterating, so request
 * errors surface on the first step and not at the call. Iterate it fully or `break`, so
 * the connection is released.
 *
 * `stream` composes with `schema`: the tokens then spell out the JSON, so concatenate
 * them and parse at the end.
 *
 * @param transport - The client to send through.
 * @param query - Natural-language question (max 1500 chars).
 * @param options - Scoping, generation and streaming knobs. See {@link AskOptions}.
 * @returns The answer, or an async iterable of events when streaming.
 * @throws StreamError - If the server reports a failure mid-stream; the answer is
 *   incomplete at that point.
 */
export function ask(
  transport: Transport,
  query: string,
  options?: AskOptions & { stream?: false },
): Promise<AskResponse>
export function ask(
  transport: Transport,
  query: string,
  options: AskOptions & { stream: true },
): AsyncGenerator<AskEvent, void, undefined>
export function ask(
  transport: Transport,
  query: string,
  options: AskOptions & { stream?: boolean } = {},
): Promise<AskResponse> | AsyncGenerator<AskEvent, void, undefined> {
  if (options.stream) return askStream(transport, query, options)
  return askOnce(transport, query, options)
}

async function askOnce(
  transport: Transport,
  query: string,
  options: AskOptions,
): Promise<AskResponse> {
  return transport.request<AskResponse>("POST", ASK_PATH, {
    json: await askBody(transport, query, options),
    ...(options.signal ? { signal: options.signal } : {}),
  })
}

/** Yield typed events off the SSE stream, throwing on an `error` event. */
async function* askStream(
  transport: Transport,
  query: string,
  options: AskOptions,
): AsyncGenerator<AskEvent, void, undefined> {
  const body = { ...(await askBody(transport, query, options)), stream: true }
  const lines = transport.stream("POST", ASK_PATH, {
    json: body,
    ...(options.signal ? { signal: options.signal } : {}),
  })

  for await (const [name, data] of parseSse(lines)) {
    const payload: Record<string, unknown> = data ? JSON.parse(data) : {}
    if (name === "error") {
      const detail = payload.detail ?? (Object.keys(payload).length ? payload : null)
      throw new StreamError(
        `ask stream failed: ${detail === null ? "no detail" : String(typeof detail === "object" ? JSON.stringify(detail) : detail)}`,
        { body: payload },
      )
    }
    // Events arrive off the raw stream, not through `request`, so they are camelized
    // here instead.
    if (name === "sources") {
      yield {
        type: "sources",
        results: (camelize(payload.results) as AskResultItem[] | undefined) ?? [],
      }
    } else if (name === "token") {
      yield {
        type: "token",
        text: typeof payload.text === "string" ? payload.text : "",
      }
    } else if (name === "done") {
      yield { type: "done" }
    }
    // An unknown event type is skipped, not an error: forward compatibility.
  }
}
