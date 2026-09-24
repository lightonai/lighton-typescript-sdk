/**
 * Shared active-record plumbing for the resource models.
 *
 * The read-side lifecycle (list/get/refresh/delete) and the client-binding internals are
 * identical across Workspace/Tag/ApiKey/File, so they live here. What genuinely diverges
 * stays on the subclass: the field schema, `create()` (JSON vs multipart body), and
 * `save()` (the per-resource PATCH payload).
 *
 * Subclasses set three statics: `base` (URL path), `resource` (the noun used in error
 * messages), and `fields` (the names {@link ActiveRecord.absorb} is allowed to copy).
 */

import type { Query, RequestOptions, Transport } from "./client.ts"
import { paginate } from "./utils.ts"

/** The static side of a resource class, as `list`/`get` need to see it. */
export interface RecordClass<T extends ActiveRecord> {
  new (...args: never[]): T
  base: string
  resource: string
  fields: readonly string[]
}

export abstract class ActiveRecord {
  /** Server-assigned id; null until created or retrieved. */
  id: number | string | null = null

  /** The client bound by create()/get()/list(). @internal */
  protected transport: Transport | null = null

  /** URL path for the collection, e.g. `/api/v3/workspaces`. @internal */
  static base = ""
  /** Noun used in the not-persisted error message. @internal */
  static resource = "resource"
  /**
   * Field names {@link absorb} may copy off a response.
   *
   * TypeScript has no runtime view of an interface, so the list is explicit. It is also
   * what keeps a response from writing arbitrary keys onto a resource.
   *
   * @internal
   */
  static fields: readonly string[] = ["id"]

  /** Build a bound instance from a response row. @internal */
  static hydrate<T extends ActiveRecord>(
    cls: RecordClass<T>,
    client: Transport,
    data: Record<string, unknown>,
  ): T {
    const record = new cls()
    record.transport = client
    return record.absorb(data)
  }

  /**
   * Re-fetch this resource from the API.
   *
   * @returns `this`, updated with the latest field values.
   */
  async refresh(): Promise<this> {
    const base = (this.constructor as typeof ActiveRecord).base
    return this.absorb(await this.api("GET", `${base}/${this.id}`))
  }

  /** Delete this resource and clear its local id. */
  async delete(): Promise<void> {
    const base = (this.constructor as typeof ActiveRecord).base
    await this.api("DELETE", `${base}/${this.id}`)
    this.id = null
  }

  /**
   * The bound client, or an error if this instance isn't persisted yet.
   *
   * @throws Error - If the instance has no id or no bound client.
   * @internal
   */
  protected boundClient(): Transport {
    const { resource } = this.constructor as typeof ActiveRecord
    if (this.id === null || this.transport === null) {
      throw new Error(`${resource} must be created or retrieved first`)
    }
    return this.transport
  }

  /** Send a request through the bound client. @internal */
  protected api<T = Record<string, unknown>>(
    method: string,
    path: string,
    options?: RequestOptions,
  ): Promise<T> {
    return this.boundClient().request<T>(method, path, options)
  }

  /** Bind a client without going through the server. @internal */
  protected bind(client: Transport): this {
    this.transport = client
    return this
  }

  /**
   * Copy returned fields onto this instance, overwriting **only what the response
   * actually carried**.
   *
   * This is load-bearing, not an optimization. Three fields depend on it:
   * `Workspace.taxonomy` (the detail endpoint omits the key), `ApiKey.key` (returned by
   * create() alone), and `File.path` (local only, never in any response). A plain
   * `Object.assign` would wipe all three on the next refresh().
   *
   * @internal
   */
  protected absorb(data: Record<string, unknown> | null): this {
    if (!data) return this
    const allowed = (this.constructor as typeof ActiveRecord).fields
    const self = this as unknown as Record<string, unknown>
    for (const field of allowed) {
      if (field in data) self[field] = data[field]
    }
    return this
  }
}

/**
 * List every row of a resource, following pagination to the end.
 *
 * A free function rather than an inherited static: each resource then declares its own
 * `list` with an honest signature (Workspace takes no filters, File takes two, Tag has no
 * `get` at all), which a generic static on the base cannot express without the static
 * side becoming unassignable.
 *
 * @param cls - The resource class to build rows into.
 * @param client - The client to request with and bind to each result.
 * @param params - Optional query filters, sent on the first page.
 * @returns All matching resources, each bound to `client`.
 * @internal
 */
export async function listAll<T extends ActiveRecord>(
  cls: RecordClass<T>,
  client: Transport,
  params?: Query,
): Promise<T[]> {
  // `page` would start the walk part-way through and silently drop what came before.
  // The filter types already omit it; this covers untyped callers.
  const { page: _page, ...query } = params ?? {}
  const rows = await paginate<Record<string, unknown>>(client, cls.base, query)
  return rows.map((row) => ActiveRecord.hydrate(cls, client, row))
}

/**
 * Fetch a single resource by id.
 *
 * @param cls - The resource class to build the row into.
 * @param client - The client to request with and bind to the result.
 * @param id - The resource id to retrieve.
 * @returns The resource, bound to `client`.
 * @internal
 */
export async function getOne<T extends ActiveRecord>(
  cls: RecordClass<T>,
  client: Transport,
  id: number | string,
): Promise<T> {
  const data = await client.request<Record<string, unknown>>("GET", `${cls.base}/${id}`)
  return ActiveRecord.hydrate(cls, client, data)
}
