/**
 * Tags: a flat, company-wide label set you can scope queries to.
 *
 * Active-record style, but the tags API is **list/create/delete only**: there is no
 * `GET /tags/<id>`, so the inherited `get()` and `refresh()` throw rather than 404 at
 * runtime. Tags scope `ask` and `search` through their `tags` option.
 */

import { ActiveRecord, listAll } from "./activeRecord.ts"
import type { Transport } from "./client.ts"
import { paginate } from "./utils.ts"

export const TAGS_BASE = "/api/v3/tags"
const NO_GET = "the tags API has no single-tag GET; use Tag.list(client)"

export interface TagInit {
  name?: string
  description?: string
  /** If true the system may auto-assign this tag; else it is user-only. */
  autoAssign?: boolean
}

export class Tag extends ActiveRecord {
  override id: number | null = null
  name = ""
  description = ""
  autoAssign = true

  /** Number of documents carrying this tag (read-only). */
  documentCount?: number | null
  createdAt?: string | null
  updatedAt?: string | null

  static override base = TAGS_BASE
  static override resource = "tag"
  static override fields = [
    "id",
    "name",
    "description",
    "autoAssign",
    "documentCount",
    "createdAt",
    "updatedAt",
  ]

  constructor(init: TagInit = {}) {
    super()
    Object.assign(this, init)
  }

  /**
   * Create this tag and bind the client for later lifecycle calls.
   *
   * @param client - The client to create the tag with and bind to `this`.
   * @returns `this`, updated with the server-assigned id.
   */
  async create(client: Transport): Promise<this> {
    const data = await client.request<Record<string, unknown>>("POST", TAGS_BASE, {
      json: {
        name: this.name,
        description: this.description,
        auto_assign: this.autoAssign,
      },
    })
    return this.bind(client).absorb(data)
  }

  /**
   * List every tag, following pagination to the end.
   *
   * @param client - The client to request with and bind to each result.
   * @returns Every tag, bound to `client`.
   */
  static list(client: Transport): Promise<Tag[]> {
    return listAll(Tag, client)
  }

  /**
   * Not available: the tags API exposes no single-tag GET.
   *
   * Declared so the failure is a clear message at the call site rather than a 404 from
   * a URL that was never going to exist. Use {@link Tag.list} instead.
   *
   * @throws Error - Always.
   */
  static get(): Promise<never> {
    throw new Error(NO_GET)
  }

  /** @throws Error - Always: the tags API exposes no single-tag GET. */
  override refresh(): Promise<never> {
    throw new Error(NO_GET)
  }
}

/** A `Tag`, its id, or its name. The three mix freely in one list. */
export type TagRef = number | string | Tag | { readonly id: number | string | null }

interface TagRow {
  id: number
  name: string
}

/**
 * Resolve a mixed list of tags, ids and names to plain ids.
 *
 * Names cost one `GET /api/v3/tags`, and only when at least one is present. An unknown
 * name throws rather than silently dropping the filter, which would quietly widen the
 * query instead of narrowing it.
 *
 * Ids keep their relative order and resolved names are appended after them, matching the
 * Python SDK so the two produce identical request bodies.
 *
 * @param transport - The client to look names up through.
 * @param tags - Tag objects, ids, or names.
 * @returns The resolved tag ids.
 * @throws Error - If a name matches no tag, or a `Tag` has no id yet.
 */
export async function resolveTagIds(
  transport: Transport,
  tags: readonly TagRef[],
): Promise<(number | string)[]> {
  const resolved: (number | string)[] = []
  const names: string[] = []

  for (const tag of tags) {
    if (typeof tag === "string") {
      names.push(tag)
    } else if (typeof tag === "number") {
      resolved.push(tag)
    } else if (tag.id === null) {
      throw new Error("cannot resolve an unsaved Tag (no id)")
    } else {
      resolved.push(tag.id)
    }
  }
  if (names.length === 0) return resolved

  const all = await paginate<TagRow>(transport, TAGS_BASE)
  const byName = new Map(all.map((row) => [row.name, row.id]))
  const missing = names.filter((name) => !byName.has(name))
  if (missing.length > 0) {
    throw new Error(`unknown tag name(s): ${missing.join(", ")}`)
  }
  for (const name of names) resolved.push(byName.get(name) as number)
  return resolved
}
