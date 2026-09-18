/**
 * API keys.
 *
 * The plaintext secret (`key`) is returned by `create()` only, once. list/get/save/
 * refresh never resend it, so create is the one chance to read it. It survives a later
 * `refresh()` purely because `absorb` overwrites only the keys a response carried.
 */

import { ActiveRecord, getOne, listAll } from "./activeRecord.ts"
import type { Transport } from "./client.ts"
import type { Role } from "./enums.ts"

const BASE = "/api/v3/keys"

/** Access granted on one workspace. */
export interface ApiKeyScope {
  workspaceId: number
  role: Role
}

export interface ApiKeyInit {
  name?: string
  /** Expiry timestamp (ISO-8601); omit for no expiry. */
  expiresAt?: string | null
  /** Per-workspace access scopes; omit or leave empty for an unscoped key. */
  scopes?: ApiKeyScope[]
}

export class ApiKey extends ActiveRecord {
  /** String id, unlike every other resource. */
  override id: string | null = null
  name = ""
  expiresAt?: string | null
  scopes: ApiKeyScope[] = []

  /** Non-secret key prefix for identification (read-only). */
  prefix?: string | null
  createdAt?: string | null
  /** The plaintext secret. Returned by `create()` only, once. */
  key?: string | null

  static override base = BASE
  static override resource = "api key"
  static override fields = [
    "id",
    "name",
    "expiresAt",
    "scopes",
    "prefix",
    "createdAt",
    "key",
  ]

  constructor(init: ApiKeyInit = {}) {
    super()
    Object.assign(this, init)
  }

  /**
   * List every API key. The plaintext secret is never included.
   *
   * @param client - The client to request with and bind to each result.
   * @returns Every key, bound to `client`.
   */
  static list(client: Transport): Promise<ApiKey[]> {
    return listAll(ApiKey, client)
  }

  /**
   * Fetch a single API key by id. The plaintext secret is never included.
   *
   * @param client - The client to request with and bind to the result.
   * @param id - The key id to retrieve.
   * @returns The key, bound to `client`.
   */
  static get(client: Transport, id: string): Promise<ApiKey> {
    return getOne(ApiKey, client, id)
  }

  /** Scopes on the wire. Empty means unscoped, which the API spells `null`, not `[]`. */
  #scopePayload(): { workspace_id: number; role: Role }[] | null {
    if (this.scopes.length === 0) return null
    return this.scopes.map((scope) => ({
      workspace_id: scope.workspaceId,
      role: scope.role,
    }))
  }

  /**
   * Create this API key and bind the client for later lifecycle calls.
   *
   * @param client - The client to create the key with and bind to `this`.
   * @returns `this`, updated with the id and the one-time plaintext `key`.
   */
  async create(client: Transport): Promise<this & { id: string }> {
    const data = await client.request<Record<string, unknown>>("POST", BASE, {
      json: {
        name: this.name,
        expires_at: this.expiresAt ?? null,
        scopes: this.#scopePayload(),
      },
    })
    return this.bind(client).absorb(data) as this & { id: string }
  }

  /**
   * Persist local edits to name and scopes.
   *
   * @returns `this`, refreshed with the server's response, which never re-includes `key`.
   */
  async save(): Promise<this> {
    const data = await this.api("PATCH", `${BASE}/${this.id}`, {
      json: { name: this.name, scopes: this.#scopePayload() },
    })
    return this.absorb(data)
  }
}
