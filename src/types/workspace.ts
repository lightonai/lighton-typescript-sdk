/** Workspace-adjacent data shapes. The behavior lives on `Workspace`. */

/** How many of a workspace's documents sit under one root content type. */
export interface RootContentType {
  /** Root content-type path, e.g. `legal`. */
  path: string
  /** Human-readable label for that root. */
  label: string
  /** Documents classified under it, including children. */
  count: number
}

/**
 * How much of a workspace is classified, and under which roots.
 *
 * The cheapest way to see classification coverage without listing files. Only the list
 * endpoint returns it; the detail endpoint omits the key entirely, so `get()` and
 * `refresh()` leave whatever was already there rather than clearing it.
 */
export interface WorkspaceTaxonomy {
  /** Fraction of the workspace's files that carry a content type, 0 to 1. */
  classifiedFilesRate: number
  /** Per-root document counts, one entry per root content type. */
  rootContentTypes: RootContentType[]
}

/**
 * The external datasource a workspace imports from, when one is connected.
 *
 * Null on a workspace whose documents were uploaded directly.
 */
export interface WorkspaceSync {
  name?: string | null
  datasourceType?: string | null
  sourceName?: string | null
  /** Outcome of the last import run. */
  lastStatus?: string | null
  /** When the sync last ran; null if it never has. */
  updatedAt?: string | null
  /** When the next import is due; null if none is scheduled. */
  nextImportDate?: string | null
  /** Files the last run could not import. */
  failedFilesCount?: number | null
  /** Whether the caller may change this configuration. */
  editable?: boolean | null
  instanceUrl?: string | null
  tenantId?: string | null
  siteName?: string | null
  clientId?: string | null
  /** Datasource-specific import filter, passed through as-is. */
  filterCriteria?: unknown
}
