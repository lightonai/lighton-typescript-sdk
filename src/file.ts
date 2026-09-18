/**
 * Files.
 *
 * Uploading a file to a workspace *is* the ingestion: `POST /api/v3/files` returns a File
 * carrying a processing `status` (pending, converting, parsing, embedding, embedded, or a
 * failure state). There is no separate ingestion-job resource; you poll this same File
 * with `refresh()` or `wait()` until it is terminal.
 *
 * `create()` is a multipart upload, unlike the JSON `create()` on Workspace and ApiKey.
 */

import { ActiveRecord, getOne, listAll } from "./activeRecord.ts"
import type { Query, Transport } from "./client.ts"
import type { Facet } from "./contentType.ts"
import { DownloadPurpose, type FileStatus, type ReprocessLevel } from "./enums.ts"
import { LightOnError } from "./errors.ts"
import { resolveTagIds, type TagRef } from "./tag.ts"
import type { ExternalMetadata, Thumbnail } from "./types/file.ts"
import type { Page } from "./types/index.ts"
import { basename, toFilePart } from "./upload.ts"
import { compact, type IdRef, ids, type PathRef, path as toPath } from "./utils.ts"

const BASE = "/api/v3/files"

/** Terminal ingestion states. Everything else means still in flight. */
const TERMINAL_OK: readonly string[] = ["embedded", "parsed"]
const TERMINAL_BAD: readonly string[] = ["parsing_failed", "embedding_failed", "fail"]

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export interface FileInit {
  /** Local path to upload. Node-family runtimes only; elsewhere pass `blob`. */
  path?: string
  /** File bytes, for runtimes with no filesystem. Needs `filename`. */
  blob?: Blob
  /** Target workspace. `Workspace.ingest()` fills this in for you. */
  workspaceId?: number
  /** Document filename; defaults to the path's basename on upload. */
  filename?: string
  /** Document title; defaults to the filename server-side. */
  title?: string
  externalMetadata?: ExternalMetadata
}

export interface FileListOptions {
  workspaceId?: number
  title?: string
}

export interface CreateOptions {
  /** Tag ids to assign on upload. */
  tags?: number[]
  /** Overrides the `externalMetadata` field when both are set. */
  externalMetadata?: ExternalMetadata
}

export interface SaveOptions {
  /**
   * Replacement tags: this **replaces** every tag on the document, auto-assigned
   * included. Omit to leave tags untouched; pass `[]` to clear them all.
   */
  tags?: readonly TagRef[]
  /** Origin fields to **merge** into what is stored. Omit to leave it untouched. */
  externalMetadata?: ExternalMetadata
}

export interface WaitOptions {
  /** Milliseconds before giving up. Default 300_000. */
  timeoutMs?: number
  /** Milliseconds between status checks. Default 2000. */
  pollMs?: number
}

/**
 * Serialize external metadata for a form field.
 *
 * `compact` here is load-bearing, not tidiness. It keeps an unset field out of the
 * payload (a null `doc_type` is rejected with 422) while an empty string still goes
 * through, which is what makes the blank-clear work. It only walks the top level, so a
 * null *inside* `additionalMetadata` survives, which is how one key gets cleared.
 */
function externalMetadataField(meta: ExternalMetadata): string {
  return JSON.stringify(
    compact({
      external_id: meta.externalId,
      doc_type: meta.docType,
      additional_metadata: meta.additionalMetadata,
    }),
  )
}

export class File extends ActiveRecord {
  override id: number | null = null

  /** Local source path; set before create(), never present in a response. */
  path?: string
  /** Source bytes, as an alternative to `path`. Never present in a response. */
  blob?: Blob
  workspaceId?: number | null
  filename?: string | null
  title?: string | null
  externalMetadata?: ExternalMetadata | null

  /** Ingestion pipeline status (read-only). */
  status?: FileStatus | null
  /** Free-text error detail, present only on failure (read-only). */
  statusDetail?: string | null
  /**
   * Reprocessing queued but not started (read-only).
   *
   * While this is set, `status` and the file-derived fields still describe the
   * *previous* run; it clears the moment processing starts. `update` means a file
   * replacement.
   */
  pendingReprocess?: ReprocessLevel | null
  extension?: string | null
  totalPages?: number | null
  size?: number | null
  /** Check `status` is `READY` before calling `downloadThumbnail()`. */
  thumbnail?: Thumbnail | null
  createdAt?: string | null
  updatedAt?: string | null

  static override base = BASE
  static override resource = "file"
  // `path` and `blob` are absent: they are local-only and no response carries them, so
  // leaving them out of absorb() is what lets them survive a refresh().
  static override fields = [
    "id",
    "workspaceId",
    "filename",
    "title",
    "externalMetadata",
    "status",
    "statusDetail",
    "pendingReprocess",
    "extension",
    "totalPages",
    "size",
    "thumbnail",
    "createdAt",
    "updatedAt",
  ]

  constructor(init: FileInit = {}) {
    super()
    Object.assign(this, init)
  }

  /**
   * List files, optionally filtered to one workspace.
   *
   * @param client - The client to request with and bind to each result.
   * @param options - `workspaceId` and `title` filters.
   * @returns Every matching file, following pagination to the end.
   */
  static list(client: Transport, options: FileListOptions = {}): Promise<File[]> {
    const params = compact({
      workspace_id: options.workspaceId,
      title: options.title,
    }) as Query
    return listAll(File, client, params)
  }

  /**
   * Fetch a single file by id.
   *
   * @param client - The client to request with and bind to the result.
   * @param id - The file id to retrieve.
   * @returns The file, bound to `client`.
   */
  static get(client: Transport, id: number | string): Promise<File> {
    return getOne(File, client, id)
  }

  /**
   * Fetch every file with this user-facing name in a workspace.
   *
   * Matches `title`, not `filename`: the server uniquifies filenames on upload
   * (`report.pdf` is stored as something like `report_20260728_c9be.pdf`), so the name
   * you uploaded never matches the stored one. A title defaults to the uploaded filename
   * without its extension, so `report.pdf` and `report` both find that upload.
   *
   * Titles are not unique the way stored filenames are, so this returns every match
   * rather than picking one. The API's `title` filter is a case-insensitive *partial*
   * match, so candidates are narrowed to an exact title match here.
   *
   * @param client - The client to query with and bind to the results.
   * @param name - The file's title, with or without an extension.
   * @param workspace - The workspace to search in (a `Workspace` or its id).
   * @returns Every File with that title; empty if none match.
   * @throws Error - If the workspace has not been created or retrieved.
   */
  static async getByName(
    client: Transport,
    name: string,
    workspace: IdRef,
  ): Promise<File[]> {
    const workspaceId = typeof workspace === "number" ? workspace : workspace.id
    if (workspaceId === null || workspaceId === undefined) {
      throw new Error("workspace must be created or retrieved (has no id)")
    }
    // A title defaults to the filename minus its extension.
    const stem = basename(name).replace(/\.[^.]+$/, "")
    const candidates = await File.list(client, {
      workspaceId: workspaceId as number,
      title: stem,
    })
    return candidates.filter((file) => file.title === name || file.title === stem)
  }

  /**
   * Delete many files in one request.
   *
   * All-or-nothing: if any id is unknown (or not yours), the API rejects the whole call
   * with 404 and deletes **nothing**, which surfaces as a `NotFoundError`. There is no
   * partial-success result to report, so a failure throws rather than returning a
   * per-file report: nothing was deleted, and retrying with the ids you can account for
   * is the fix.
   *
   * @param client - The client to delete with.
   * @param files - Files or bare ids, mixed. Empty is a local no-op, because the
   *   endpoint rejects an empty list.
   * @throws NotFoundError - If any id is unknown; no file is deleted in that case.
   */
  static async deleteMany(
    client: Transport,
    files: readonly (File | number)[],
  ): Promise<void> {
    const targets = ids(files)
    if (!targets || targets.length === 0) return
    await client.request("POST", `${BASE}/bulk-delete`, { json: { ids: targets } })
    for (const file of files) {
      if (typeof file !== "number") file.id = null
    }
  }

  /**
   * Upload the file. This starts ingestion.
   *
   * @param client - The client to upload with and bind to `this`.
   * @param options - Tags to assign, and external metadata. See {@link CreateOptions}.
   * @returns `this`, updated with the server-assigned id and initial status.
   * @throws Error - If no source or no `workspaceId` is set.
   */
  async create(
    client: Transport,
    options: CreateOptions = {},
  ): Promise<this & { id: number }> {
    if (this.workspaceId === null || this.workspaceId === undefined) {
      throw new Error("workspaceId is required (or use Workspace.ingest)")
    }
    const part = await toFilePart(this.#source())
    const form = new FormData()
    form.append("workspace_id", String(this.workspaceId))
    form.append("filename", this.filename || part.filename)
    if (this.title) form.append("title", this.title)
    // Repeated fields, which is how the API reads a list out of a form body.
    for (const tag of options.tags ?? []) form.append("tags", String(tag))
    if (options.externalMetadata) this.externalMetadata = options.externalMetadata
    if (this.externalMetadata) {
      // A nested object can't ride as a form field; JSON-encode it, the way extract
      // sends `schema` and `options` alongside a multipart upload.
      form.append("external_metadata", externalMetadataField(this.externalMetadata))
    }
    form.append("file", part.blob, part.filename)

    const data = await client.request<Record<string, unknown>>("POST", BASE, {
      body: form,
    })
    return this.bind(client).absorb(data) as this & { id: number }
  }

  /**
   * Persist local edits to `title`, plus whatever you pass explicitly.
   *
   * `filename` is immutable server-side. `title` is a plain field: set it and save.
   * `tags` and `externalMetadata` are **options, not fields**, because neither is a plain
   * set server-side, and naming them at the call site says which one you are doing.
   * Omitting either leaves that part of the document untouched, so a bare `save()` only
   * ever writes the title.
   *
   * @param options - Replacement tags and metadata to merge. See {@link SaveOptions}.
   * @returns `this`, refreshed with the server's response, so `externalMetadata` shows
   *   the merged result rather than the partial value you sent.
   */
  async save(options: SaveOptions = {}): Promise<this> {
    // Form-encoded, not JSON: the /files endpoints accept only multipart and
    // x-www-form-urlencoded, and reject a JSON body with 415.
    const form = new URLSearchParams()
    // Omitted rather than sent empty: a form body encodes an absent value as "", which
    // would blank the title server-side.
    if (this.title !== null && this.title !== undefined)
      form.append("title", this.title)
    if (options.externalMetadata) {
      form.append("external_metadata", externalMetadataField(options.externalMetadata))
    }
    if (options.tags) {
      const resolved = await resolveTagIds(this.boundClient(), options.tags)
      // The API wants a [0] sentinel to clear: an empty list vanishes from a form body,
      // and the resulting empty PATCH is rejected outright.
      const tags = resolved.length > 0 ? resolved : [0]
      for (const tag of tags) form.append("tags", String(tag))
    }
    return this.absorb(await this.api("PATCH", `${BASE}/${this.id}`, { body: form }))
  }

  /**
   * Replace this document's content in place.
   *
   * The document keeps its id, title, tags and content-type classifications, and is
   * re-ingested from the new content, so every reference to the id survives what used to
   * need a delete plus a re-upload. The new file may be of a different type. `filename`
   * follows the new file, but `title` is preserved, so a replaced document is still found
   * under the name it was uploaded with.
   *
   * Addressed by **id**, never by name: titles and filenames aren't unique, so resolve to
   * the one document you mean first.
   *
   * @param source - Local path, `File`, or `{filename, blob}` whose content replaces the
   *   current one.
   * @param options - `wait` to block until re-ingestion is terminal, plus `timeoutMs`.
   * @returns `this`. Without `wait`, the absorbed fields still describe the *previous*
   *   content, see `pendingReprocess`.
   */
  async replace(
    source: string | Blob | { filename: string; blob: Blob },
    options: WaitOptions & { wait?: boolean } = {},
  ): Promise<this> {
    const part = await toFilePart(source)
    if (typeof source === "string") this.path = source
    const form = new FormData()
    form.append("file", part.blob, part.filename)
    this.absorb(await this.api("PATCH", `${BASE}/${this.id}`, { body: form }))
    // The response reports `pendingReprocess: "update"` alongside the *previous* run's
    // status, and wait() knows not to trust a status while that is set.
    return options.wait ? this.wait(options) : this
  }

  /**
   * Download this document's stored bytes.
   *
   * @param purpose - Which stored version to fetch. The server falls back to `original`
   *   when the requested purpose has no associated file, so this never 404s just because
   *   a rendition is missing.
   * @returns The file content.
   */
  download(
    purpose: DownloadPurpose | string = DownloadPurpose.original,
  ): Promise<Uint8Array> {
    return this.api<Uint8Array>("GET", `${BASE}/${this.id}/download`, {
      params: { purpose },
      raw: true,
    })
  }

  /**
   * Fetch the parsed text of this document, one entry per page.
   *
   * The platform stores what it parsed at ingestion, so this reads it back instead of
   * re-uploading and re-parsing a document it already has. The result is the **same**
   * `{index, markdown}` shape `parse` returns, so code can move between parsing a local
   * file and reading an ingested one without reshaping anything.
   *
   * A method, not a field: the text can be large, and most callers of `refresh()` don't
   * want it riding along.
   *
   * @returns One Page per page. Empty if the document has no stored text.
   */
  async pages(): Promise<Page[]> {
    const data = await this.api<{ pages?: Page[] | null }>(
      "GET",
      `${BASE}/${this.id}`,
      { params: { include_content: true } },
    )
    return data.pages ?? []
  }

  /**
   * Download this document's 256x256 WebP thumbnail.
   *
   * Generated asynchronously and **independently of ingestion**, so an embedded file may
   * still have none. Check the `thumbnail` field first.
   *
   * @returns The WebP image.
   * @throws NotFoundError - If no thumbnail exists (status is not `READY`).
   */
  downloadThumbnail(): Promise<Uint8Array> {
    return this.api<Uint8Array>("GET", `${BASE}/${this.id}/thumbnail`, { raw: true })
  }

  /**
   * Assign tags to this file.
   *
   * @param tags - Tags to add: `Tag` objects, ids, or names, mixed. Empty is a no-op.
   * @returns `this`, refreshed from the response.
   */
  async tag(tags: readonly TagRef[]): Promise<this> {
    const resolved = await resolveTagIds(this.boundClient(), tags)
    if (resolved.length === 0) return this
    return this.absorb(
      await this.api("POST", `${BASE}/${this.id}/tags`, { json: { tags: resolved } }),
    )
  }

  /**
   * Remove tags from this file, one request each: there is no bulk tag delete.
   *
   * @param tags - Tags to remove: `Tag` objects, ids, or names, mixed. Empty is a no-op.
   * @returns `this`.
   */
  async untag(tags: readonly TagRef[]): Promise<this> {
    for (const tagId of await resolveTagIds(this.boundClient(), tags)) {
      await this.api("DELETE", `${BASE}/${this.id}/tags/${tagId}`)
    }
    return this
  }

  #facet(
    action: string,
    contentType: PathRef,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    return this.api("POST", `${BASE}/${this.id}/facets`, {
      json: { action, content_type_path: toPath(contentType), ...extra },
    })
  }

  /** Assign a content type to this file. */
  async classify(contentType: PathRef): Promise<this> {
    await this.#facet("classify", contentType)
    return this
  }

  /** Remove a content-type assignment from this file. */
  async unclassify(contentType: PathRef): Promise<this> {
    await this.#facet("unclassify", contentType)
    return this
  }

  /**
   * Set an attribute value under an assigned content type.
   *
   * @param contentType - The assigned content type, or its path.
   * @param name - Attribute identifier (snake_case).
   * @param value - The value; its shape follows the attribute type (string, number,
   *   date `YYYY-MM-DD`, boolean, or string[] for multi-select).
   */
  async setAttribute(
    contentType: PathRef,
    name: string,
    value: unknown,
  ): Promise<this> {
    await this.#facet("set_value", contentType, { attribute_name: name, value })
    return this
  }

  /** Clear an attribute value under an assigned content type. */
  async clearAttribute(contentType: PathRef, name: string): Promise<this> {
    await this.#facet("clear_value", contentType, { attribute_name: name })
    return this
  }

  /** List this file's assigned content types and their attribute values. */
  async facets(): Promise<Facet[]> {
    const data = await this.api<{ contentTypes?: Facet[] | null }>(
      "GET",
      `${BASE}/${this.id}/facets`,
    )
    return data.contentTypes ?? []
  }

  /** The upload source, from whichever of `blob`/`path` was set. */
  #source(): string | Blob | { filename: string; blob: Blob } {
    if (this.blob) {
      if (!this.filename) {
        throw new Error("File.filename is required when uploading from a blob")
      }
      return { filename: this.filename, blob: this.blob }
    }
    if (this.path) return this.path
    throw new Error("File.path or File.blob is required to upload")
  }

  /**
   * Poll until ingestion reaches a terminal state.
   *
   * A pending reprocess counts as *not* terminal: while `pendingReprocess` is set the
   * queued work has not started and `status` still reports the previous run, so trusting
   * it would call a `replace()` done before it began.
   *
   * ponytail: a plain poll loop, because the API offers no webhook. Use
   * {@link waitAll} to run several concurrently.
   *
   * @param options - `timeoutMs` and `pollMs`. See {@link WaitOptions}.
   * @returns `this`, once `status` is terminal-success and no reprocess is queued.
   * @throws Error - If the timeout elapses first.
   * @throws LightOnError - If ingestion ends in a terminal-failure state.
   */
  async wait(options: WaitOptions = {}): Promise<this> {
    const timeoutMs = options.timeoutMs ?? 300_000
    const pollMs = options.pollMs ?? 2000
    const deadline = Date.now() + timeoutMs
    while (
      this.pendingReprocess !== null && this.pendingReprocess !== undefined
        ? true
        : !TERMINAL_OK.includes(this.status ?? "") &&
          !TERMINAL_BAD.includes(this.status ?? "")
    ) {
      if (Date.now() > deadline) {
        const queued = this.pendingReprocess
          ? ` (reprocess ${this.pendingReprocess} queued)`
          : ""
        throw new Error(
          `file ${this.id} still ${this.status}${queued} after ${timeoutMs}ms`,
        )
      }
      await sleep(pollMs)
      await this.refresh()
    }
    if (TERMINAL_BAD.includes(this.status ?? "")) {
      throw new LightOnError(`ingestion failed (${this.status}): ${this.statusDetail}`)
    }
    return this
  }
}

/**
 * Wait for many ingestions at once.
 *
 * @param files - The files to wait on; each is polled via `file.wait()`.
 * @param options - Passed to each `wait()`.
 * @returns The same files, once each has reached a terminal-success status.
 * @throws Error - If any file does not finish in time.
 * @throws LightOnError - If any file's ingestion ends in a terminal-failure state.
 */
export function waitAll(
  files: readonly File[],
  options: WaitOptions = {},
): Promise<File[]> {
  return Promise.all(files.map((file) => file.wait(options)))
}
