/** LightOn SDK errors. */

/** Base class for every error raised by this SDK. */
export class LightOnError extends Error {
  override name = "LightOnError"
}

/** Transport failure before any response was received (DNS, timeout, reset). */
export class LightOnConnectionError extends LightOnError {
  override name = "LightOnConnectionError"
}

/** A 2xx response body was not valid JSON. */
export class MalformedResponseError extends LightOnError {
  override name = "MalformedResponseError"
}

/**
 * The server sent an `error` event partway through a stream.
 *
 * Not a `LightOnAPIError`: the HTTP response was a perfectly good 200 and the failure
 * happened during generation, so there is no status code to carry. The answer is
 * incomplete, which is why this throws instead of arriving as one more event a caller
 * could mistake for a finished answer. `body` holds the payload.
 */
export class StreamError extends LightOnError {
  override name = "StreamError"
  readonly body: unknown

  constructor(message: string, options: { body?: unknown; cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.body = options.body ?? null
  }
}

/** The API returned a non-2xx response. */
export class LightOnAPIError extends LightOnError {
  override name = "LightOnAPIError"
  readonly statusCode: number
  readonly body: unknown

  constructor(
    message: string,
    options: { statusCode: number; body?: unknown; cause?: unknown },
  ) {
    super(message, { cause: options.cause })
    this.statusCode = options.statusCode
    this.body = options.body ?? null
  }
}

/** 401, bad or missing API key (the request is not authenticated). */
export class AuthenticationError extends LightOnAPIError {
  override name = "AuthenticationError"
}

/**
 * 403, authenticated, but the key lacks permission for this operation.
 *
 * Distinct from `AuthenticationError`: the credentials are valid, but the caller isn't
 * allowed (e.g. an endpoint that requires the CompanyAdmin role).
 */
export class PermissionDeniedError extends LightOnAPIError {
  override name = "PermissionDeniedError"
}

/** 404, the resource does not exist. */
export class NotFoundError extends LightOnAPIError {
  override name = "NotFoundError"
}

/**
 * 429, too many requests.
 *
 * `retryAfter` is the seconds to wait before retrying, from the `Retry-After` response
 * header when the server sends it (else null).
 */
export class RateLimitError extends LightOnAPIError {
  override name = "RateLimitError"
  readonly retryAfter: number | null

  constructor(
    message: string,
    options: {
      statusCode: number
      body?: unknown
      retryAfter?: number | null
      cause?: unknown
    },
  ) {
    super(message, options)
    this.retryAfter = options.retryAfter ?? null
  }
}

/** 5xx, the API failed to handle the request. */
export class ServerError extends LightOnAPIError {
  override name = "ServerError"
}

/**
 * 503 during a planned maintenance window, not a crash.
 *
 * A `ServerError` subclass, so existing `catch (e) { if (e instanceof ServerError) }`
 * handlers keep working; check for this specifically to tell "come back later" apart
 * from "this broke", since only one of the two is worth retrying.
 *
 * `mode` is `full_shutdown` or `warning_banner` (both block the request), `reason` is
 * operator-supplied text, `startedAt` is when the window opened, and
 * `endpointCategories` names the affected categories, empty meaning every endpoint. The
 * untouched payload is always on `.body`.
 */
export class MaintenanceError extends ServerError {
  override name = "MaintenanceError"
  readonly mode: string | null
  readonly reason: string | null
  readonly startedAt: Date | null
  readonly endpointCategories: string[]

  constructor(
    message: string,
    options: {
      statusCode: number
      body?: unknown
      mode?: string | null
      reason?: string | null
      startedAt?: Date | null
      endpointCategories?: string[] | null
      cause?: unknown
    },
  ) {
    super(message, options)
    this.mode = options.mode ?? null
    this.reason = options.reason ?? null
    this.startedAt = options.startedAt ?? null
    this.endpointCategories = options.endpointCategories ?? []
  }
}

const MAINTENANCE = "service_maintenance"

const STATUS_MAP: Record<number, new (m: string, o: never) => LightOnAPIError> = {
  401: AuthenticationError,
  403: PermissionDeniedError,
  404: NotFoundError,
}

/**
 * Map a non-2xx response to the right error subclass.
 *
 * Reads the body, which is why this is async: unlike httpx, a `fetch` body is one-shot.
 *
 * @param response - The non-2xx response to map.
 * @returns The error to throw. Never throws itself, an unreadable body becomes null.
 */
export async function fromResponse(response: Response): Promise<LightOnAPIError> {
  const body = await safeBody(response)
  const statusCode = response.status
  const detail = isRecord(body) ? body.detail : body
  const status = response.statusText
    ? `${statusCode} ${response.statusText}`
    : String(statusCode)
  const message = detail ? `${status}: ${String(detail)}` : status

  if (statusCode === 429) {
    return new RateLimitError(message, {
      statusCode,
      body,
      retryAfter: retryAfterSeconds(response),
    })
  }
  if (isRecord(body) && body.error === MAINTENANCE) {
    return new MaintenanceError(message, {
      statusCode,
      body,
      mode: asString(body.mode),
      reason: asString(body.reason),
      startedAt: asDate(body.started_at),
      endpointCategories: asStringArray(body.endpoint_category_names),
    })
  }
  const Mapped = STATUS_MAP[statusCode]
  if (Mapped) return new Mapped(message, { statusCode, body } as never)
  if (statusCode >= 500) return new ServerError(message, { statusCode, body })
  return new LightOnAPIError(message, { statusCode, body })
}

/**
 * Seconds from the `Retry-After` header.
 *
 * ponytail: seconds form only, the rarely-used HTTP-date form returns null; add date
 * parsing if the API starts using it.
 */
function retryAfterSeconds(response: Response): number | null {
  const raw = response.headers.get("Retry-After")
  if (raw === null) return null
  const seconds = Number(raw)
  return Number.isFinite(seconds) ? seconds : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string") : []
}

/** Parse an ISO-8601 timestamp, or null. The raw value stays on `.body`. */
function asDate(value: unknown): Date | null {
  if (typeof value !== "string") return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

async function safeBody(response: Response): Promise<unknown> {
  let text: string
  try {
    text = await response.text()
  } catch {
    return null
  }
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
