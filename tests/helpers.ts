import { LightOn } from "../src/client.ts"
import type { LightOnConfiguration } from "../src/types/config.ts"

export type Handler = (request: Request) => Response | Promise<Response>

/** A client answering from `handler`, with pacing and 429 retries off. */
export function makeClient(
  handler: Handler,
  config: LightOnConfiguration = {},
): LightOn {
  return new LightOn("k", {
    rateLimitRetries: 0,
    maxRequestsPerMinute: null,
    fetch: (input, init) => Promise.resolve(handler(new Request(input, init))),
    ...config,
  })
}

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
