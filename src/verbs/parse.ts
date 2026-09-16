/** `parse`: a document into per-page Markdown (inline, or an async job you poll). */

import type { Transport } from "../client.ts"
import { ExecMode } from "../enums.ts"
import { ParseJob } from "../job.ts"
import type { ParseResponse } from "../types/index.ts"
import { type FileSource, toFilePart } from "../upload.ts"

const PARSE_PATH = "/api/v3/parse"

export interface ParseOptions {
  /** A local path, `File`, or `{filename, blob}` to upload. Excludes `url`. */
  file?: FileSource
  /** A publicly accessible URL for the server to fetch. Excludes `file`. */
  url?: string
  /** Caller cancellation. */
  signal?: AbortSignal
}

export interface ParseAsyncOptions extends ParseOptions {
  mode: typeof ExecMode.async
  /** Block until the job is terminal, so the returned job already carries its result. */
  wait?: boolean
  /** With `wait`, how long to wait before throwing. Default 300_000. */
  timeoutMs?: number
}

/**
 * `POST /api/v3/parse`, parse a document into per-page text.
 *
 * Pass exactly one of `file` or `url`.
 *
 * @param transport - The client to send through.
 * @param options - Source, execution mode, and waiting. See {@link ParseOptions}.
 * @returns A `ParseResponse` when inline, a {@link ParseJob} when `mode` is `async`,
 *   pollable (the default) or already finished (`wait: true`).
 * @throws Error - If not exactly one of `file`/`url` is given, or `wait` is used
 *   without `mode: "async"` (inline already blocks).
 */
export function parse(
  transport: Transport,
  options: ParseOptions & { mode?: typeof ExecMode.sync },
): Promise<ParseResponse>
export function parse(
  transport: Transport,
  options: ParseAsyncOptions,
): Promise<ParseJob>
export async function parse(
  transport: Transport,
  options: ParseOptions & { mode?: ExecMode; wait?: boolean; timeoutMs?: number },
): Promise<ParseResponse | ParseJob> {
  const { file, url, mode = ExecMode.sync, wait = false } = options
  if ((file === undefined) === (url === undefined)) {
    throw new Error("parse() requires exactly one of 'file' or 'url'")
  }
  const isAsync = mode === ExecMode.async
  if (wait && !isAsync) {
    throw new Error('wait is only meaningful with mode: "async"')
  }
  const signal = options.signal ? { signal: options.signal } : {}

  let response: Record<string, unknown>
  if (file !== undefined) {
    const part = await toFilePart(file)
    const form = new FormData()
    form.append("file", part.blob, part.filename)
    // Multipart: options ride as a JSON-encoded form field.
    if (isAsync) form.append("options", JSON.stringify({ async: true }))
    response = await transport.request("POST", PARSE_PATH, { body: form, ...signal })
  } else {
    const body: Record<string, unknown> = { document: url }
    if (isAsync) body.options = { async: true }
    response = await transport.request("POST", PARSE_PATH, { json: body, ...signal })
  }

  if (!isAsync) return response as unknown as ParseResponse
  const job = ParseJob.from(transport, PARSE_PATH, response)
  return wait
    ? job.wait(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
    : job
}
