/** `extract`: structured data from a document, guided by a JSON schema. */

import type { Transport } from "../client.ts"
import { ExecMode } from "../enums.ts"
import { ExtractJob } from "../job.ts"
import { asJsonSchema, type SchemaInput } from "../schema.ts"
import type { ExtractJobResponse } from "../types/index.ts"
import { type FileSource, toFilePart } from "../upload.ts"
import { type IdRef, id } from "../utils.ts"

const EXTRACT_PATH = "/api/v3/extract"

export interface ExtractOptions {
  /** A local path, `File`, or `{filename, blob}` to upload. */
  file?: FileSource
  /** A publicly accessible URL for the server to fetch. */
  url?: string
  /**
   * An already-ingested file (a `File` or its id). No re-upload: the server reads the
   * document it already has, which is the cheapest of the three sources.
   */
  ingested?: IdRef
  /** Free-form request options, merged into the body. */
  options?: Record<string, unknown>
  /** Caller cancellation. */
  signal?: AbortSignal
}

export interface ExtractAsyncOptions extends ExtractOptions {
  mode: typeof ExecMode.async
  /** Block until the job is terminal, so the returned job already carries its result. */
  wait?: boolean
  /** With `wait`, how long to wait before throwing. Default 300_000. */
  timeoutMs?: number
}

/**
 * `POST /api/v3/extract`, extract structured data from a document.
 *
 * Pass exactly one of `file`, `url` or `ingested`.
 *
 * @param transport - The client to send through.
 * @param schema - The guided-generation schema driving extraction: a Zod schema or a
 *   plain JSON Schema object. Give every field a meaningful description, the model reads
 *   them as instructions, not documentation.
 * @param options - Source, execution mode, and waiting. See {@link ExtractOptions}.
 * @returns An `ExtractJobResponse` (with data) when inline, an {@link ExtractJob} when
 *   `mode` is `async`, pollable (the default) or already finished (`wait: true`).
 * @throws Error - If not exactly one source is given, or `wait` is used without
 *   `mode: "async"` (inline already blocks).
 */
export function extract(
  transport: Transport,
  schema: SchemaInput,
  options: ExtractOptions & { mode?: typeof ExecMode.sync },
): Promise<ExtractJobResponse>
export function extract(
  transport: Transport,
  schema: SchemaInput,
  options: ExtractAsyncOptions,
): Promise<ExtractJob>
export async function extract(
  transport: Transport,
  schema: SchemaInput,
  options: ExtractOptions & { mode?: ExecMode; wait?: boolean; timeoutMs?: number },
): Promise<ExtractJobResponse | ExtractJob> {
  const { file, url, ingested, mode = ExecMode.sync, wait = false } = options
  const sources = [file, url, ingested].filter((s) => s !== undefined).length
  if (sources !== 1) {
    throw new Error("extract() requires exactly one of 'file', 'url' or 'ingested'")
  }
  const isAsync = mode === ExecMode.async
  if (wait && !isAsync) {
    throw new Error('wait is only meaningful with mode: "async"')
  }

  const extras = isAsync ? { ...options.options, async: true } : options.options
  const jsonSchema = await asJsonSchema(schema)
  const signal = options.signal ? { signal: options.signal } : {}

  let response: Record<string, unknown>
  if (file !== undefined) {
    const part = await toFilePart(file)
    const form = new FormData()
    form.append("file", part.blob, part.filename)
    // Multipart: schema and options ride as JSON-encoded form fields.
    form.append("schema", JSON.stringify(jsonSchema))
    if (extras !== undefined) form.append("options", JSON.stringify(extras))
    response = await transport.request("POST", EXTRACT_PATH, { body: form, ...signal })
  } else {
    const source =
      url !== undefined ? { document: url } : { file_id: id(ingested as IdRef) }
    const body: Record<string, unknown> = { ...source, schema: jsonSchema }
    if (extras !== undefined) body.options = extras
    response = await transport.request("POST", EXTRACT_PATH, { json: body, ...signal })
  }

  if (!isAsync) return response as unknown as ExtractJobResponse
  const job = ExtractJob.from(transport, EXTRACT_PATH, response)
  return wait
    ? job.wait(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
    : job
}
