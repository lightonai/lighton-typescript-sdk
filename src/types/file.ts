/** File-adjacent data shapes. The behavior lives on `File`. */

import type { ThumbnailStatus } from "../enums.ts"

/**
 * Where a document came from in a third-party system.
 *
 * Set it on upload (or with `save()`) and it survives on the File, so a later sync can
 * match the platform document back to the record it was ingested from.
 *
 * Updates **merge** server-side, including into `additionalMetadata`: patching one key
 * leaves the others in place. There is no replace mode and no way to drop the record.
 * What you *can* clear, verified against the live API:
 *
 * | to remove | how |
 * | --- | --- |
 * | `docType` | `{ docType: "" }` |
 * | one key of `additionalMetadata` | `{ additionalMetadata: { version: null } }` |
 * | `externalId` | not possible, it can only be overwritten |
 * | the whole record | not possible |
 */
export interface ExternalMetadata {
  /** Document id in the source system; required the first time. */
  externalId?: string | null
  /** Document type in the source system, e.g. `incident`. */
  docType?: string | null
  /** Arbitrary JSON (url, version, timestamps), passed through as-is. */
  additionalMetadata?: unknown
}

/**
 * Whether a file's 256x256 WebP thumbnail exists yet, and where it lives.
 *
 * Generation is asynchronous and independent of ingestion, so check `status` before
 * fetching: `file.downloadThumbnail()` 404s while it isn't `READY`.
 */
export interface Thumbnail {
  status?: ThumbnailStatus | null
  /** Relative URL to the image; null unless status is `READY`. */
  url?: string | null
}
