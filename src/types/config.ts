/** Client configuration. */

export const DEFAULT_BASE_URL = "https://api.lighton.ai"

/**
 * Non-essential client knobs. `apiKey` stays a direct `LightOn()` argument, so a config
 * object can be shared or logged without carrying a secret.
 */
export interface LightOnConfiguration {
  /** API root, host only. The SDK appends `/api/v3/...` itself. */
  baseUrl?: string

  /**
   * Whole-request timeout in milliseconds. Default 120_000.
   *
   * ponytail: one timeout, where the Python SDK splits connect (5s) from read (120s).
   * `fetch` cannot express the split, and `AbortSignal.timeout` covers the case that
   * actually hurts. Move to a custom dispatcher if a connect-only deadline is needed.
   */
  timeout?: number

  /** Connection-level retries, with exponential backoff. Does not cover HTTP errors. */
  retries?: number

  /**
   * The `fetch` to send through. Defaults to the global one.
   *
   * This is the seam tests use to answer requests without a network, the way the Python
   * SDK injects an `httpx.MockTransport`. It is also where a proxy dispatcher goes.
   */
  fetch?: typeof globalThis.fetch

  /**
   * Pace ALL requests to stay under this per-minute cap (a min-interval gate in
   * `request`). Defaults to 1000, the API's limit for most endpoints; override if your
   * account differs. Set null to disable pacing entirely.
   */
  maxRequestsPerMinute?: number | null

  /**
   * On HTTP 429, retry this many times, waiting the `Retry-After` header when present
   * (else exponential backoff). 0 disables.
   */
  rateLimitRetries?: number
}
