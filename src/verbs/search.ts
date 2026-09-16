/** `search`: retrieve relevant passages, no generation. */

import type { Transport } from "../client.ts"
import type { RelevanceScoring, SearchMode } from "../enums.ts"
import type { SearchResponse } from "../types/index.ts"
import { compact } from "../utils.ts"
import { type ScopeOptions, scopeBody } from "./scope.ts"

export interface SearchOptions extends ScopeOptions {
  /** Chunks to return after reranking (1 to 100; server default 10). */
  maxResults?: number
  /** `text` (hybrid keyword + vector) or `vision` (page image). */
  mode?: SearchMode
  /** Defaults to `scoringAndFiltering` server-side. */
  relevanceScoring?: RelevanceScoring
  /** Attach a base64 page image to each result. */
  includeImage?: boolean
  /** Attach chunk bounding boxes (PDF text-mode only). */
  includeBboxes?: boolean
}

/**
 * `POST /api/v3/search`, retrieve relevant passages (no generation).
 *
 * @param transport - The client to send through.
 * @param query - Natural-language search query (max 4000 chars).
 * @param options - Scoping and retrieval knobs. See {@link SearchOptions}.
 * @returns The ranked search results.
 */
export async function search(
  transport: Transport,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResponse> {
  const body = {
    query,
    ...(await scopeBody(transport, options)),
    ...compact({
      max_results: options.maxResults,
      mode: options.mode,
      relevance_scoring: options.relevanceScoring,
      include_image: options.includeImage,
      include_bboxes: options.includeBboxes,
    }),
  }
  return transport.request<SearchResponse>("POST", "/api/v3/search", {
    json: body,
    ...(options.signal ? { signal: options.signal } : {}),
  })
}
