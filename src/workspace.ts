/**
 * Workspaces.
 *
 * Active-record style: a Workspace instance manages its own lifecycle. `create()` binds a
 * client to the instance, and later `save()`/`refresh()`/`delete()` reuse it.
 */

import { ActiveRecord, getOne, listAll } from "./activeRecord.ts"
import { type BatchIngestJob, type BatchOptions, runBatch } from "./batch.ts"
import type { Transport } from "./client.ts"
import { ExecMode, type Role } from "./enums.ts"
import type { File, WaitOptions } from "./file.ts"
import type { BatchIngest } from "./types/batch.ts"
import type { WorkspaceSync, WorkspaceTaxonomy } from "./types/workspace.ts"

const BASE = "/api/v3/workspaces"

export interface WorkspaceInit {
  name?: string
  description?: string
}

export interface IngestOptions extends WaitOptions {
  /** Block until ingestion reaches a terminal status. */
  wait?: boolean
  /** Tag ids to assign to the document on upload. */
  tags?: number[]
}

export class Workspace extends ActiveRecord {
  override id: number | null = null
  name = ""
  description = ""

  /** Workspace type (read-only). */
  workspaceType?: string | null
  /** How documents are uploaded to this workspace (read-only). */
  documentUploadMethod?: string | null
  filesCount?: number | null
  /** Bytes of storage used (read-only). */
  usedStorage?: number | null
  createdAt?: string | null
  updatedAt?: string | null
  /** Your role on this workspace (read-only). Null when you hold none. */
  userRole?: Role | null
  /**
   * Classification coverage and per-root document counts (read-only).
   *
   * Only `list()` returns it. The detail endpoint omits the key entirely, so `get()` and
   * `refresh()` neither populate it nor clear an already-loaded value. Re-list for fresh
   * coverage numbers.
   */
  taxonomy?: WorkspaceTaxonomy | null
  /**
   * External datasource this workspace imports from (read-only); null when documents are
   * uploaded directly.
   */
  sync?: WorkspaceSync | null

  static override base = BASE
  static override resource = "workspace"
  static override fields = [
    "id",
    "name",
    "description",
    "workspaceType",
    "documentUploadMethod",
    "filesCount",
    "usedStorage",
    "createdAt",
    "updatedAt",
    "userRole",
    "taxonomy",
    "sync",
  ]

  constructor(init: WorkspaceInit = {}) {
    super()
    Object.assign(this, init)
  }

  /**
   * List every workspace, following pagination to the end.
   *
   * Only this call returns `taxonomy` and the other listing-only extras.
   *
   * @param client - The client to request with and bind to each result.
   * @returns Every workspace, bound to `client`.
   */
  static list(client: Transport): Promise<Workspace[]> {
    return listAll(Workspace, client)
  }

  /**
   * Fetch a single workspace by id.
   *
   * @param client - The client to request with and bind to the result.
   * @param id - The workspace id to retrieve.
   * @returns The workspace, bound to `client`.
   */
  static get(client: Transport, id: number | string): Promise<Workspace> {
    return getOne(Workspace, client, id)
  }

  /**
   * Create this workspace and bind the client for later lifecycle calls.
   *
   * @param client - The client to create the workspace with and bind to `this`.
   * @returns `this`, updated with the server-assigned id and read-only fields.
   */
  async create(client: Transport): Promise<this & { id: number }> {
    const data = await client.request<Record<string, unknown>>("POST", BASE, {
      json: { name: this.name, description: this.description },
    })
    return this.bind(client).absorb(data) as this & { id: number }
  }

  /**
   * Persist local edits to name and description.
   *
   * @returns `this`, refreshed with the server's response.
   */
  async save(): Promise<this> {
    const data = await this.api("PATCH", `${BASE}/${this.id}`, {
      json: { name: this.name, description: this.description },
    })
    return this.absorb(data)
  }

  /**
   * Upload a File into this workspace. Uploading *is* the ingestion.
   *
   * Non-blocking by default: the returned File is `pending`, poll it with `refresh()` or
   * `wait()`. Pass `wait: true` to block until ingestion is terminal.
   *
   * @param file - The File to upload; its `workspaceId` is set to this workspace.
   * @param options - `wait`, `timeoutMs`, and tag ids. See {@link IngestOptions}.
   * @returns The created File, bound to this workspace's client.
   * @throws Error - If this workspace has not been created or retrieved yet.
   */
  async ingest(
    file: File,
    options: IngestOptions = {},
  ): Promise<File & { id: number }> {
    const client = this.boundClient()
    file.workspaceId = this.id
    const created = await file.create(
      client,
      options.tags ? { tags: options.tags } : {},
    )
    return options.wait ? await created.wait(options) : created
  }

  /**
   * Upload many files into this workspace, concurrently.
   *
   * Every local path is validated to exist **before** any upload starts. Staying under
   * the API rate limit and honoring the 429 cooldown are the client's job, so they apply
   * across uploads and status polls alike.
   *
   * @param files - Items to ingest: `File` objects and path strings, mixed. A string
   *   containing `*`, `?` or `[` is expanded as a glob (`**` works); duplicates are
   *   ignored. Files carrying a `blob` need no filesystem.
   * @param options - Execution mode, error handling and concurrency. See
   *   {@link BatchOptions}.
   * @returns A {@link BatchIngest} inline, or a {@link BatchIngestJob} with
   *   `mode: "async"`.
   * @throws Error - If this workspace has no id, or an item has neither path nor blob.
   * @throws Error - If any path is missing and `ignoreErrors` is unset.
   */
  ingestMany(
    files: readonly (File | string)[],
    options?: BatchOptions & { mode?: typeof ExecMode.sync },
  ): Promise<BatchIngest>
  ingestMany(
    files: readonly (File | string)[],
    options: BatchOptions & { mode: typeof ExecMode.async },
  ): Promise<BatchIngestJob>
  ingestMany(
    files: readonly (File | string)[],
    options: BatchOptions & { mode?: ExecMode } = {},
  ): Promise<BatchIngest | BatchIngestJob> {
    const client = this.boundClient()
    return runBatch(client, this.id as number, files, {
      ...options,
      async: options.mode === ExecMode.async,
    })
  }

  /**
   * The API sends `""` for "no role", which isn't a Role, so read it as null rather than
   * widening the type to include a meaningless empty string.
   */
  protected override absorb(data: Record<string, unknown> | null): this {
    if (data && data.userRole === "") {
      return super.absorb({ ...data, userRole: null })
    }
    return super.absorb(data)
  }
}
