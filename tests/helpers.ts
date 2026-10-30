import { LightOn } from "../src/client.ts"
import { FacetScope } from "../src/contentType.ts"
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

/** A scope response with one scored content type and no completion, on the wire. */
export const SCOPE = {
  has_signal: true,
  groups: [
    {
      root: "patent",
      root_label: "Patent",
      max_score: 1.85,
      content_types: [
        {
          path: "patent:electricity",
          label: "Electricity",
          root: "patent",
          score: 1.85,
          chunk_count: 15,
          doc_count: 18000,
          attributes: [],
        },
      ],
    },
  ],
  prompt_context: "ctx",
  prompt_version: null,
  scope_completion: null,
}

/** A scope already resolved with a model, so applying it needs no request. */
export const RESOLVED_SCOPE = new FacetScope({
  hasSignal: true,
  groups: [],
  scopeCompletion: {
    contentType: "patent:electricity",
    attribute: ["filing_date:>=2023-01-01"],
    rawOutput: "",
    normalized: false,
    warnings: [],
  },
})

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
