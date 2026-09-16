/** Scoping arguments shared by `ask` and `search`. */

import type { Transport } from "../client.ts"
import { resolveTagIds, type TagRef } from "../tag.ts"
import { compact, type IdRef, ids, type PathRef, paths } from "../utils.ts"

export interface ScopeOptions {
  /** Restrict to these workspaces. Excludes `files`. */
  workspaces?: readonly IdRef[]
  /**
   * Restrict to documents carrying any of these tags (OR-matched). Accepts `Tag`
   * objects, ids, or names; names are resolved via the tags endpoint and must exist.
   * Excludes `files`.
   */
  tags?: readonly TagRef[]
  /** Restrict to these files. Excludes `workspaces` and `tags`. */
  files?: readonly IdRef[]
  /**
   * Restrict to these content-type paths (OR-matched, exact-or-subtree, so `legal` also
   * matches `legal:contract`). Wildcards: `legal:contract*`, `*nda*`.
   */
  contentType?: readonly PathRef[]
  /**
   * Restrict by attribute value, e.g. `["fiscal_year:2024|2025", "status:active"]`.
   * Entries are ANDed, `|` ORs within one entry. Also `name` (has any value),
   * `name:>value`, `name:prefix*`, `name:*text*`.
   */
  attribute?: readonly string[]
  /** Caller cancellation. */
  signal?: AbortSignal
}

/** The wire-name scope fields, with tag names already resolved to ids. */
export async function scopeBody(
  transport: Transport,
  options: ScopeOptions,
): Promise<Record<string, unknown>> {
  const tagIds = options.tags ? await resolveTagIds(transport, options.tags) : undefined
  return compact({
    workspace_id: ids(options.workspaces),
    tag_id: tagIds,
    file_id: ids(options.files),
    content_type: paths(options.contentType),
    attribute: options.attribute ? [...options.attribute] : undefined,
  })
}
