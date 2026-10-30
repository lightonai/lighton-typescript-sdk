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
  /**
   * Errors on the last import session, session-level notes included. For SMB,
   * `walk.failedFiles` is the files-only figure.
   */
  failedFilesCount?: number | null
  /** Files still waiting to be imported. */
  pendingFilesCount?: number | null
  /**
   * True when the source refused the credentials: syncing has stopped and will not retry
   * until the credentials are replaced.
   */
  credentialsRejected?: boolean | null
  /** Whether the caller may change this configuration. */
  editable?: boolean | null
  instanceUrl?: string | null
  tenantId?: string | null
  siteName?: string | null
  clientId?: string | null
  /** Account name (SMB, ServiceNow); empty where the type has none. */
  username?: string | null
  /** SMB only: `negotiate`, `ntlm` or `kerberos`; empty otherwise. */
  authProtocol?: string | null
  /** SMB only: the Kerberos realm. */
  kerberosRealm?: string | null
  /** SMB only: the realm's KDCs, comma-separated. */
  kerberosKdcs?: string | null
  /** SMB only: address connected to when the server name in `instanceUrl` does not resolve. */
  connectAddress?: string | null
  /** Directory-walk progress; SMB only, null otherwise. */
  walk?: SyncWalk | null
  /** Datasource-specific import filter, passed through as-is. */
  filterCriteria?: unknown
}

/**
 * How far an SMB directory walk has got.
 *
 * SMB has no changes API, so a sync walks the share in batches that each report success:
 * `lastStatus` reads `success` throughout a first scan that can take days. `complete` is
 * what tells a finished walk apart.
 */
export interface SyncWalk {
  /** False while directories are left to visit. */
  complete: boolean
  /** When the walk in progress began; null before its first batch. */
  startedAt: string | null
  /** Directories queued and not yet visited; 0 once complete. */
  pendingDirectories: number
  /** Files this walk has processed so far (not the workspace total). */
  filesSeen: number
  /** Bytes pulled off the share so far. */
  bytesRead: number
  /**
   * Files of the last session that failed, files only. Prefer it over
   * `WorkspaceSync.failedFilesCount`, which also counts refused directories.
   */
  failedFiles: number
  /**
   * Directories the walk could not enter (unreadable, junction, loop, too deep). Their
   * files are absent and only the share admin can fix it.
   */
  refusedDirectoriesCount: number
  /** Up to 10 of those directories, share-relative: a sample. */
  refusedDirectories: string[]
  /**
   * True once the walk ran out of room to record what it skipped; deletion detection is
   * then off for this import.
   */
  refusalsIncomplete: boolean
}

/**
 * What the caller may do on a workspace, a scoped API key's limits included.
 *
 * Only the detail endpoint returns it (`get()`/`refresh()`), the mirror of `taxonomy`:
 * `list()` leaves it unset.
 */
export interface WorkspacePermissions {
  /** May upload files; always false on a synced workspace. */
  canUploadFiles: boolean
  /** May delete files; always false on a synced workspace. */
  canDeleteFiles: boolean
  /** May update name and description. */
  canEditWorkspace: boolean
  /**
   * May edit the datasource; false once a sync has succeeded (the configuration is then
   * locked) or when there is none.
   */
  canEditDatasource: boolean
  /**
   * May replace the datasource's credentials or pause/resume it; unlike
   * `canEditDatasource`, survives the post-sync lock.
   */
  canOperateDatasource: boolean
  /** May delete the workspace. */
  canDeleteWorkspace: boolean
  /** May list, add and remove workspace members. */
  canManageMembers: boolean
}
