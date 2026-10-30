/** Scoping arguments shared by `ask` and `search`. */

import type { Transport } from "../client.ts"
import { ContentType, type FacetScope } from "../contentType.ts"
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
   * Restrict to these content types: nodes, scored hits from `ContentType.scope()`, or
   * paths (OR-matched, exact-or-subtree, so `legal` also matches `legal:contract`).
   * Wildcards: `legal:contract*`, `*nda*`.
   */
  contentType?: readonly PathRef[]
  /**
   * Restrict by attribute value, e.g. `["fiscal_year:2024|2025", "status:active"]`.
   * Entries are ANDed, `|` ORs within one entry. Also `name` (has any value),
   * `name:>value`, `name:prefix*`, `name:*text*`.
   */
  attribute?: readonly string[]
  /**
   * Derive `contentType`/`attribute` from the query instead of naming them.
   *
   * `true` resolves a scope from this query (one extra request, no LLM) and narrows by
   * every content type it scores, up to the endpoint's default 20, so it is a loose net;
   * pass `ContentType.scope(client, query, { maxResults: 3 })` to narrow harder. A
   * `FacetScope` resolved with a `model` is applied as-is, attribute filters included;
   * that model infers the filters and is not `ask`'s answer-generation `model`. Refuses
   * to combine with an explicit `contentType`/`attribute`.
   */
  scope?: FacetScope | boolean
  /** Caller cancellation. */
  signal?: AbortSignal
}

/**
 * The wire-name scope fields, with tag names already resolved to ids and `scope` applied.
 *
 * The one place that knows what `scope` means, so `ask` and `search` cannot drift.
 *
 * @throws Error - If `scope` is combined with an explicit `contentType` or `attribute`.
 *   Merging them silently would hide which filters ran.
 */
export async function scopeBody(
  transport: Transport,
  query: string,
  options: ScopeOptions,
): Promise<Record<string, unknown>> {
  let facets: { contentType?: readonly PathRef[]; attribute?: readonly string[] } =
    options
  if (options.scope) {
    if (options.contentType !== undefined || options.attribute !== undefined) {
      throw new Error(
        "scope replaces contentType/attribute; pass the scope or the explicit " +
          "filters, not both",
      )
    }
    const resolved =
      options.scope === true ? await ContentType.scope(transport, query) : options.scope
    facets = resolved.filters()
  }
  const tagIds = options.tags ? await resolveTagIds(transport, options.tags) : undefined
  return compact({
    workspace_id: ids(options.workspaces),
    tag_id: tagIds,
    file_id: ids(options.files),
    content_type: paths(facets.contentType),
    attribute: facets.attribute ? [...facets.attribute] : undefined,
  })
}
