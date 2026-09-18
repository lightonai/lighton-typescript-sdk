/** Batch-ingestion result shapes. The behavior lives in `src/batch.ts`. */

import type { File } from "../file.ts"

/** One item of a batch that did not make it. */
export interface FailedIngest {
  /** The path or pattern it came from; empty when the source was a blob. */
  source: string
  /** Why it failed: the upload error, the ingestion error, or a missing path. */
  error: Error
  /** The File, when the failure was at *ingestion* rather than upload. */
  file?: File
}

/** The terminal outcome of a batch. */
export interface BatchIngest {
  succeeded: File[]
  failed: FailedIngest[]
  /** Whether every item made it. */
  ok: boolean
}

/** A snapshot of a running batch. */
export interface BatchProgress {
  total: number
  /** Uploads the API has accepted. */
  uploaded: number
  /** Files that have finished ingesting. Stays 0 unless the batch is waiting. */
  ingested: number
  failed: number
  done: boolean
}
