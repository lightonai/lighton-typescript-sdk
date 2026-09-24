/**
 * Curated aliases over the generated API types.
 *
 * Each one runs the wire shape through {@link Camelize}, so it is computed once here
 * rather than at every call site. The generated module keeps the server's snake_case
 * names; nothing outside the transport should reference it directly.
 */

import type { Camelize } from "../utils.ts"
import type { components, operations } from "./api.ts"

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

/**
 * A list endpoint's query filters, typed from the OpenAPI schema.
 *
 * They keep the API's own parameter names (`status`, `tag_id`,
 * `external_metadata__external_id`): like `attribute` strings on search, they are the
 * server's query grammar, passed through untouched. Being generated, they follow the
 * schema on every `make gen-types` instead of drifting from it.
 *
 * `page` is left out because `list()` owns pagination: starting from page 2 would
 * silently drop page 1, which is exactly the truncation `list()` exists to prevent.
 * `page_size` stays, since it only changes how many round trips a listing takes.
 */
type ListFilters<Operation extends keyof operations> = Omit<
  NonNullable<operations[Operation]["parameters"]["query"]>,
  "page"
>

/** Filters for `File.list`, e.g. `status`, `tag_id`, `external_metadata__external_id`. */
export type FileFilters = ListFilters<"api_v3_files_list">
/** Filters for `Workspace.list`, e.g. `name`, `user_role`, `ordering`. */
export type WorkspaceFilters = ListFilters<"api_v3_workspaces_list">
/** Filters for `Tag.list`, e.g. `name`, `auto_assign`. */
export type TagFilters = ListFilters<"api_v3_tags_list">
/** Filters for `ApiKey.list`, e.g. `is_expired`. */
export type ApiKeyFilters = ListFilters<"api_v3_keys_list">

export { DEFAULT_BASE_URL, type LightOnConfiguration } from "./config.ts"
