/**
 * Curated aliases over the generated API types.
 *
 * Each one runs the wire shape through {@link Camelize}, so it is computed once here
 * rather than at every call site. The generated module keeps the server's snake_case
 * names; nothing outside the transport should reference it directly.
 */

import type { Camelize } from "../utils.ts"
import type { components } from "./api.ts"

type Schemas = components["schemas"]

/** A grounded answer plus the chunks it was grounded in. */
export type AskResponse = Camelize<Schemas["AskResponse"]>
/** One retrieved chunk used as context by `ask`. */
export type AskResultItem = Camelize<Schemas["AskResultItem"]>

/** Ranked passages, with optional warnings and scoring breakdown. */
export type SearchResponse = Camelize<Schemas["SearchResponse"]>
/** One ranked passage returned by `search`. */
export type SearchResultItem = Camelize<Schemas["SearchResultItem"]>

/**
 * One page of a document.
 *
 * Defined once and reused everywhere: `parse` returns these, and so does
 * `file.pages()`, so code moves between parsing a local file and reading an ingested one
 * without reshaping. Never redefine this shape per app.
 */
export type Page = Camelize<Schemas["Page"]>

/** A completed synchronous `parse`. */
export type ParseResponse = Camelize<Schemas["ParseResponse"]>
export type ParseResult = Camelize<Schemas["ParseResult"]>
export type ParseDocument = Camelize<Schemas["ParseDocument"]>
export type ParseUsage = Camelize<Schemas["ParseUsage"]>
export type ParseError = Camelize<Schemas["ParseError"]>

/** An `extract` job, whether it ran inline or was queued. */
export type ExtractJobResponse = Camelize<Schemas["ExtractJobResponse"]>
export type ExtractResult = Camelize<Schemas["ExtractResult"]>
export type ExtractDocument = Camelize<Schemas["ExtractDocument"]>
export type ExtractUsage = Camelize<Schemas["ExtractUsage"]>

/** Progress reported by a running async job. */
export type JobProgress = Camelize<Schemas["JobProgress"]>

export { DEFAULT_BASE_URL, type LightOnConfiguration } from "./config.ts"
