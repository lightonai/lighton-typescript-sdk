/** Tags: a flat, company-wide label set you can scope queries to. */

import type { Transport } from "./client.ts"
import { paginate } from "./utils.ts"

export const TAGS_BASE = "/api/v3/tags"

/** A `Tag`, its id, or its name. The three mix freely in one list. */
export type TagRef = number | string | { readonly id: number | string | null }

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
