/**
 * Curated status and role vocabularies shared across resources.
 *
 * `as const` objects plus a union type, not TypeScript `enum`: the members *are* their
 * strings, so `file.status === "embedded"` and `["embedded", "parsed"].includes(status)`
 * keep working, and callers may pass a plain literal anywhere an enum is accepted. A TS
 * `enum` would be a nominal type and would forbid both.
 *
 * Values mirror the generated API types. Regenerate those with `make gen-types` and
 * update here if the server vocabulary changes. Only vocabularies whose full domain is
 * known are modelled; `workspaceType` and `documentUploadMethod` stay plain strings.
 */

/**
 * Which stored version of a file to download.
 *
 * The server falls back to `original` when the requested purpose has no associated file.
 */
export const DownloadPurpose = {
  original: "original",
  renderedPdf: "rendered_pdf",
  transcript: "transcript",
} as const
export type DownloadPurpose = (typeof DownloadPurpose)[keyof typeof DownloadPurpose]

/** Whether a file's thumbnail has been generated (uppercase, as the API sends). */
export const ThumbnailStatus = {
  MISSING: "MISSING",
  PROCESSING: "PROCESSING",
  READY: "READY",
} as const
export type ThumbnailStatus = (typeof ThumbnailStatus)[keyof typeof ThumbnailStatus]

/**
 * Type of a content-type attribute column.
 *
 * `select` and `multiSelect` require `choices`; the API also accepts the aliases
 * `multiselect` and `richtext` for the hyphenated values used here.
 */
export const AttributeType = {
  text: "text",
  number: "number",
  date: "date",
  boolean: "boolean",
  select: "select",
  multiSelect: "multi-select",
  richText: "rich-text",
} as const
export type AttributeType = (typeof AttributeType)[keyof typeof AttributeType]

/** Reprocessing level queued on a File (`pendingReprocess`), `update` = replacement. */
export const ReprocessLevel = {
  reparse: "reparse",
  rechunk: "rechunk",
  reembed: "reembed",
  reembedVision: "reembed_vision",
  update: "update",
} as const
export type ReprocessLevel = (typeof ReprocessLevel)[keyof typeof ReprocessLevel]

/** Ingestion pipeline status for a File. */
export const FileStatus = {
  pending: "pending",
  pendingConversion: "pending_conversion",
  converting: "converting",
  parsing: "parsing",
  parsingFailed: "parsing_failed",
  embedding: "embedding",
  embeddingFailed: "embedding_failed",
  embedded: "embedded",
  parsed: "parsed",
  fail: "fail",
  updating: "updating",
} as const
export type FileStatus = (typeof FileStatus)[keyof typeof FileStatus]

/**
 * Status of an async parse/extract job.
 *
 * Only `pending` (initial) and `completed` (success) are documented by the API; the
 * schema types `status` as a bare string with no enum and doesn't publish the failure
 * vocabulary. This is for call-site comparisons, NOT to validate the response field, so
 * an unrecognized server value compares unequal rather than erroring. Detect terminal
 * failure via `completedAt` being set without `completed` (or, for parse, the `error`
 * block) rather than a status string.
 */
export const JobStatus = {
  pending: "pending",
  completed: "completed",
} as const
export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus]

/** Execution mode for parse/extract: run inline or queue as an async job. */
export const ExecMode = {
  sync: "sync",
  async: "async",
} as const
export type ExecMode = (typeof ExecMode)[keyof typeof ExecMode]

/** Retrieval mode for search and ask. */
export const SearchMode = {
  /** Hybrid keyword + vector. */
  text: "text",
  /** VLM-embedded page image. */
  vision: "vision",
} as const
export type SearchMode = (typeof SearchMode)[keyof typeof SearchMode]

/** Cross-encoder relevance scoring step for search. */
export const RelevanceScoring = {
  /** Skip scoring, return all candidates. */
  none: "none",
  /** Score but don't filter. */
  scoringOnly: "scoring_only",
  /** Score and drop below threshold. */
  scoringAndFiltering: "scoring_and_filtering",
} as const
export type RelevanceScoring = (typeof RelevanceScoring)[keyof typeof RelevanceScoring]

/** Access role granted by an API-key scope on a workspace. */
export const Role = {
  viewer: "viewer",
  editor: "editor",
  owner: "owner",
} as const
export type Role = (typeof Role)[keyof typeof Role]
