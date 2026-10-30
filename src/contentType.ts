/**
 * The content-type taxonomy, and a file's facets.
 *
 * Three concepts, one shape each:
 * - a **content type** is a node in the company-wide tree, e.g. `legal:contract:nda`.
 *   What kind of document this is.
 * - an **attribute** is a typed column on a content type, e.g. `jurisdiction`. What you
 *   can record.
 * - a **facet** is one content type assigned to one file, plus that file's values for its
 *   attributes. What this document actually is.
 *
 * `ContentType` is not an active record: the endpoint returns a nested tree, not a
 * paginated flat list, so there is nothing to bind a client to and no per-node lifecycle.
 * The taxonomy operations are therefore statics over one `action` helper, and a node is a
 * plain data shape. The name is an interface and a value at once, so `ContentType` reads
 * as both the type of a node and the namespace the operations hang off.
 *
 * `ContentTypeAction`/`ContentTypeResult` and `FacetAction`/`FacetResult` are the write
 * and result shapes of the two batch endpoints, `ContentType.batch()` and
 * `file.batchFacets()`.
 *
 * `FacetScope` is what `ContentType.scope()` resolves: the taxonomy ranked against a
 * natural-language query, plus the `contentType`/`attribute` filters to narrow a search
 * with. `ScopeGroup`/`ScopedContentType`/`ScopeCompletion` are its parts.
 */

import type { Query, Transport } from "./client.ts"
import {
  AttributeType,
  ContentTypeActionType,
  FacetActionType,
  RelevanceScoring,
} from "./enums.ts"
import { compact, type PathRef, path as toPath } from "./utils.ts"

const BASE = "/api/v3/content-types"

/** Actions per `ContentType.batch()` call, the API's cap. Split a longer job yourself. */
export const MAX_CONTENT_TYPE_ACTIONS = 50

/** Actions per `file.batchFacets()` call, the API's cap. Split a longer job yourself. */
export const MAX_FACET_ACTIONS = 50

/**
 * One attribute of a content type: a definition, or a value set on a file.
 *
 * Carries both the schema (`type`/`required`/`choices`) and, when read from a file's
 * facets, the current `value`. `value` is absent for a bare definition or when unset.
 */
export interface Attribute {
  /** Attribute identifier, snake_case. */
  name: string
  label?: string
  /** One of the {@link AttributeType} values. */
  type?: string
  /** Current value on the file; absent for a definition or when unset. */
  value?: unknown
  required?: boolean
  /** Allowed values, for `select` and `multi-select`. */
  choices?: string[]
  description?: string
}

/** A node in the content-type taxonomy. */
export interface ContentType {
  /** Full taxonomy path, e.g. `legal:contract:nda`. */
  path: string
  /** This node's own code segment. */
  code: string
  label: string
  description?: string
  /** Where the type is defined (read-only). */
  source?: string | null
  /** Attribute definitions, present when `includeAttributes` was set. */
  attributes?: Attribute[]
  children?: ContentType[]
}

/**
 * A starter taxonomy from the catalog, what `adopt()` imports.
 *
 * The same tree as a {@link ContentType} except for `attributes`: on a template it is a
 * **map** from node path to that node's attribute definitions, with the whole subtree's
 * attributes hanging off the root, rather than this node's own list.
 *
 * A sibling interface, not an extension: TypeScript cannot re-type an inherited member,
 * so the Python subclass (which needs a `# type: ignore` for exactly this) has no direct
 * equivalent.
 */
export interface Template extends Omit<ContentType, "attributes"> {
  /** Attribute definitions per node path, for the whole subtree. */
  attributes?: Record<string, Attribute[]>
}

/** A content type assigned to a file, with the file's attribute values on it. */
export interface Facet {
  /** Assigned content-type path on the file. */
  path: string
  label: string
  /** Attribute values set on the file. */
  attributes: Attribute[]
}

/**
 * One classification write, applied by `file.batchFacets()`.
 *
 * Build these with the statics: each takes the same arguments in the same order as the
 * `File` method of the same name, so a batch is a transcription of the single-action
 * calls it replaces.
 *
 * ```ts
 * await doc.batchFacets([
 *   FacetAction.classify(nda),
 *   FacetAction.setAttribute(nda, "jurisdiction", "FR"),
 * ])
 * ```
 *
 * The constructor is private, which is what pydantic's validator and `extra="forbid"`
 * do in the Python SDK: an action cannot be built without the fields its verb needs, nor
 * with a misspelled one. A raw wire body is the escape hatch for a verb the SDK does not
 * model yet. Nothing is sent until the list reaches a file, so one list applies to many.
 */
export class FacetAction {
  /** The write to perform, the API's verb (see {@link FacetActionType}). */
  readonly action: FacetActionType
  /** Content type the action applies to, e.g. `legal:contract:nda`. */
  readonly contentTypePath: string
  /** Attribute identifier, snake_case; null except on the value verbs. */
  readonly attributeName: string | null
  /** The value `setAttribute` writes; its shape follows the attribute type. */
  readonly value: unknown

  private constructor(
    action: FacetActionType,
    contentType: PathRef,
    attributeName: string | null = null,
    value: unknown = null,
  ) {
    this.action = action
    this.contentTypePath = toPath(contentType)
    this.attributeName = attributeName
    this.value = value
  }

  /**
   * Assign a content type, the batch form of `file.classify()`.
   *
   * @param contentType - The content type to assign, or its path.
   * @returns The action, unsent.
   */
  static classify(contentType: PathRef): FacetAction {
    return new FacetAction(FacetActionType.classify, contentType)
  }

  /**
   * Remove a content-type assignment, the batch form of `file.unclassify()`.
   *
   * @param contentType - The content type to unassign, or its path.
   * @returns The action, unsent.
   */
  static unclassify(contentType: PathRef): FacetAction {
    return new FacetAction(FacetActionType.unclassify, contentType)
  }

  /**
   * Set an attribute value, the batch form of `file.setAttribute()`.
   *
   * @param contentType - The assigned content type, or its path.
   * @param name - Attribute identifier (snake_case).
   * @param value - The value; its shape follows the attribute type (string, number,
   *   date `YYYY-MM-DD`, boolean, or string[] for multi-select).
   * @returns The action, unsent.
   */
  static setAttribute(contentType: PathRef, name: string, value: unknown): FacetAction {
    return new FacetAction(FacetActionType.setValue, contentType, name, value)
  }

  /**
   * Clear an attribute value, the batch form of `file.clearAttribute()`.
   *
   * @param contentType - The assigned content type, or its path.
   * @param name - Attribute identifier to clear.
   * @returns The action, unsent.
   */
  static clearAttribute(contentType: PathRef, name: string): FacetAction {
    return new FacetAction(FacetActionType.clearValue, contentType, name)
  }
}

/**
 * The one place that knows a facet action's wire names. The single-action methods on
 * `File` post exactly this too, so single and batch cannot drift.
 *
 * @internal
 */
export function facetBody(action: FacetAction): Record<string, unknown> {
  return {
    action: action.action,
    content_type_path: action.contentTypePath,
    ...(action.attributeName === null ? {} : { attribute_name: action.attributeName }),
    // Sent even when null: the server decides what a null value means.
    ...(action.action === FacetActionType.setValue
      ? { value: action.value ?? null }
      : {}),
  }
}

/**
 * What one action in a `file.batchFacets()` call returned.
 *
 * Every result you receive succeeded: the endpoint fails fast, so a failing action
 * throws (see `LightOnAPIError.index`) and no results come back at all. A returned list is
 * therefore always complete and in order, so `results[i]` is the outcome of `actions[i]`.
 */
export interface FacetResult {
  /**
   * Per-action status: 201 created, 200 already applied or updated, 204 for the removals
   * (`unclassify`, `clearAttribute`).
   */
  status: number
  /**
   * What the action returned, null for the 204 verbs. `classify` gives
   * `{ content_type_path, label }`, `setAttribute` gives
   * `{ name, value, content_type_path, label }`.
   *
   * Left as-is, including its wire naming: `data` is an opaque key the camelCase boundary
   * does not rewrite, because which shape it holds depends on the verb.
   */
  data: Record<string, unknown> | null
}

/**
 * What one action in a {@link ContentType.batch} call returned.
 *
 * Every result you receive succeeded: the endpoint fails fast, so a failing action
 * throws (see `LightOnAPIError.index`) and no results come back at all. A returned list is
 * therefore always complete and in order, so `results[i]` is the outcome of `actions[i]`.
 */
export interface ContentTypeResult {
  /**
   * Per-action status: 201 created, 200 already applied or updated, 204 for the removals
   * (`undefine`, `undefineAttribute`).
   */
  status: number
  /**
   * What the action returned, null for the 204 verbs: a node for the content-type verbs,
   * an attribute definition for the attribute ones, the imported roots for `adopt`.
   *
   * Left as-is, including its wire naming: `data` is an opaque key the camelCase boundary
   * does not rewrite, because which shape it holds depends on the verb. Reach for the
   * single-action methods when you want a typed result.
   */
  data: Record<string, unknown> | null
}

/** @deprecated Renamed {@link ContentTypeResult}, matching {@link FacetResult}. */
export type BatchActionResult = ContentTypeResult

/**
 * One content type scored against a query by {@link ContentType.scope}.
 *
 * It carries `path`, so it is accepted anywhere a content type is: `contentType: [hit]`
 * on `search`/`ask`, `doc.classify(hit)`, `FacetAction.classify(hit)`.
 */
export interface ScopedContentType {
  /** Full taxonomy path, e.g. `legal:contract:nda`. */
  path: string
  /** Human-readable label. */
  label: string
  /** Path of the tree this node belongs to. */
  root: string
  /** Relevance to the query; 0 when scoring was skipped. */
  score: number
  /** Chunks matching the query under this type. */
  chunkCount: number
  /** Documents classified under this type. */
  docCount: number
  /** Attribute definitions on this type; `value` is never set here. */
  attributes: Attribute[]
}

/** The scored content types of one taxonomy tree, as `scope()` groups them. */
export interface ScopeGroup {
  /** Path of the tree's root node. */
  root: string
  /** Human-readable label of the root. */
  rootLabel: string
  /** Best score among this group's types. */
  maxScore: number
  /** The tree's scored content types. */
  contentTypes: ScopedContentType[]
}

/**
 * The LLM's inferred scope, present only when `scope()` was given a `model`.
 *
 * Its `contentType`/`attribute` are already normalized to the paths and filter syntax
 * `ask`/`search` expect, which is what {@link FacetScope.filters} hands back.
 */
export interface ScopeCompletion {
  /** Inferred content-type path, null when it inferred none. */
  contentType: string | null
  /** Inferred attribute filters, e.g. `["filing_date:>=2023-01-01"]`. */
  attribute: string[]
  /** The model's unparsed output. */
  rawOutput: string
  /** Whether a label had to be mapped onto its attribute name. */
  normalized: boolean
  /**
   * Why inference degraded, empty in the happy path. A failed model call lands here
   * rather than failing the request.
   */
  warnings: string[]
}

/**
 * A search scope resolved from a question, what {@link ContentType.scope} returns.
 *
 * Pass it to `ask`/`search` as `scope`, or read {@link FacetScope.filters} yourself.
 */
export class FacetScope {
  /** Whether any content type scored above `threshold`. */
  readonly hasSignal: boolean
  /** Scored content types, grouped by tree, in the server's order. */
  readonly groups: readonly ScopeGroup[]
  /**
   * LLM-ready description of the matched schema. Feed it to your own model when you
   * resolve the scope yourself (no `model`).
   */
  readonly promptContext: string | null
  /**
   * Hash of the prompt template and the data behind it, for reproducing a run. Same value
   * means the same prompt was built.
   */
  readonly promptVersion: string | null
  /** The LLM's inferred scope; null unless `scope()` got a `model`. */
  readonly completion: ScopeCompletion | null

  /**
   * Wrap a scope response. {@link ContentType.scope} does this for you; build one
   * yourself to reapply a scope you stored.
   *
   * @param data - The response, camelCase, as `ContentType.scope()` receives it. The
   *   wire's `scopeCompletion` lands on `completion`.
   */
  constructor(data: {
    hasSignal: boolean
    groups: readonly ScopeGroup[]
    promptContext?: string | null
    promptVersion?: string | null
    scopeCompletion?: ScopeCompletion | null
  }) {
    this.hasSignal = data.hasSignal
    this.groups = data.groups
    this.promptContext = data.promptContext ?? null
    this.promptVersion = data.promptVersion ?? null
    this.completion = data.scopeCompletion ?? null
  }

  /** Every scored content type across the groups, best score first. */
  get contentTypes(): ScopedContentType[] {
    return this.groups
      .flatMap((group) => group.contentTypes)
      .sort((a, b) => b.score - a.score)
  }

  /**
   * The `contentType`/`attribute` filters this scope narrows to.
   *
   * Passing the scope itself, `client.search(query, { scope })`, applies these for you;
   * read them here to see (or log) what a scope would narrow to before spending the
   * search on it. They spread straight into `search`/`ask` options.
   *
   * Precedence:
   *
   * 1. A `completion` that inferred anything wins. That is an explicit answer from the
   *    model, and `hasSignal` (a retrieval-score gate) must not veto it.
   * 2. Otherwise, no signal means no narrowing, so `{}`.
   * 3. Otherwise the scored paths, which is retrieval-only narrowing. **Every** scored
   *    path, not just the best: `threshold` gates `hasSignal` for the whole scope and is
   *    not echoed per hit, so there is nothing to cut on here. Narrowing to the top few
   *    is `maxResults: 3` at resolve time. No attribute filters either: inferring those
   *    needs a `model`.
   *
   * @returns `contentType` and/or `attribute`, empty when the scope narrows nothing. A key
   *   is absent rather than empty, so a missing filter reads the same as one never asked
   *   for.
   */
  filters(): { contentType?: string[]; attribute?: string[] } {
    const done = this.completion
    if (done && (done.contentType || done.attribute.length > 0)) {
      return {
        ...(done.contentType ? { contentType: [done.contentType] } : {}),
        ...(done.attribute.length > 0 ? { attribute: [...done.attribute] } : {}),
      }
    }
    if (!this.hasSignal) return {}
    const paths = this.contentTypes.map((ct) => ct.path)
    return paths.length > 0 ? { contentType: paths } : {}
  }
}

export interface ContentTypeScopeOptions {
  /** Content types to return (1 to 100; server default 20). */
  maxResults?: number
  /** Score above which `hasSignal` goes true (server default 1.8). Pass 0 to disable. */
  threshold?: number
  /**
   * Technical name of the LLM that infers the scope. Omit to get `promptContext` and run
   * your own. On `ask`, this is a different model from its answer-generation `model`.
   */
  model?: string
  /**
   * Only `none` is accepted here: skip scoring and return the whole catalog at score 0,
   * ignoring `maxResults` and `threshold`. Omit for the default scoring.
   */
  relevanceScoring?: typeof RelevanceScoring.none
}

export interface ContentTypeListOptions {
  /** Restrict to the subtree rooted at this path. */
  path?: string
  /** How many levels of children to return. */
  depth?: number
  /** Populate each node's `attributes` definitions. */
  includeAttributes?: boolean
  /** Free-text filter over labels and paths. */
  query?: string
}

export interface DefineOptions {
  /** Parent node or path; omit for a root node. */
  parent?: PathRef
  description?: string
  /** Whether children inherit this node's attributes (server default true). */
  inheritAttributes?: boolean
}

export interface DefineAttributeOptions {
  /**
   * Allowed values. **Required** for `select` and `multi-select`, and rejected by the
   * server for every other type.
   */
  choices?: string[]
  /** Human-readable label; defaults to a title-cased `name`. */
  label?: string
  description?: string
  /** Whether the schema requires a value (server default false). */
  required?: boolean
}

/**
 * One taxonomy write, applied by {@link ContentType.batch}.
 *
 * Build these with the statics: each takes the same arguments in the same order as the
 * `ContentType` operation of the same name, minus `client`, so a batch is a transcription
 * of the single-action calls it replaces.
 *
 * ```ts
 * await ContentType.batch(client, [
 *   ContentTypeAction.define("compliance", "Compliance"),
 *   ContentTypeAction.defineAttribute("compliance", "owner", AttributeType.text),
 * ])
 * ```
 *
 * One wide shape rather than five, which is how the API models it too: the fields are the
 * union of the five action shapes, each documented with the verbs it belongs to, and the
 * private constructor means only the statics can fill them, so each verb gets exactly
 * its own. A raw wire body is the escape hatch for a verb the SDK does not model yet.
 * Nothing is sent until the list reaches `batch()`, so one list seeds many tenants.
 */
export class ContentTypeAction {
  /** The write to perform, the API's verb (see {@link ContentTypeActionType}). */
  declare readonly action: ContentTypeActionType
  /** Template root paths to import; `adopt` only. */
  declare readonly contentTypes?: readonly string[]
  /** Parent node path; `define` only, absent for a root. */
  declare readonly parentPath?: string
  /** The node's own segment, lowercase with hyphens; `define` only. */
  declare readonly code?: string
  /** Node the action applies to; every verb but `adopt` and `define`. */
  declare readonly contentTypePath?: string
  /** Human-readable label; required by `define`, optional on `defineAttribute`. */
  declare readonly label?: string
  /** Free-text description; `define` and `defineAttribute`. */
  declare readonly description?: string
  /** Whether children inherit this node's attributes (server default true); `define`. */
  declare readonly inheritAttributes?: boolean
  /** Attribute identifier, snake_case; `defineAttribute` and `undefineAttribute`. */
  declare readonly name?: string
  /** An {@link AttributeType}, or the equivalent string; `defineAttribute` only. */
  declare readonly attributeType?: AttributeType | string
  /** Whether the schema requires a value (server default false); `defineAttribute`. */
  declare readonly required?: boolean
  /** Allowed values, required for select and multi-select; `defineAttribute` only. */
  declare readonly choices?: readonly string[]

  // `declare` fields plus one assign: a plain field would be defined as an own property
  // set to undefined on every action, whatever its verb.
  private constructor(
    fields: {
      -readonly [K in keyof ContentTypeAction]?: ContentTypeAction[K] | undefined
    },
  ) {
    Object.assign(this, compact(fields))
  }

  /**
   * Import starter trees, the batch form of {@link ContentType.adopt}.
   *
   * @param paths - Template root paths to import, e.g. `["legal", "finance"]`.
   * @returns The action, unsent.
   */
  static adopt(paths: readonly string[]): ContentTypeAction {
    return new ContentTypeAction({
      action: ContentTypeActionType.adopt,
      contentTypes: [...paths],
    })
  }

  /**
   * Create or update a node, the batch form of {@link ContentType.define}.
   *
   * @param code - This node's own segment, lowercase alphanumeric with hyphens.
   * @param label - Human-readable label.
   * @param options - Parent, description, and attribute inheritance.
   * @returns The action, unsent.
   */
  static define(
    code: string,
    label: string,
    options: DefineOptions = {},
  ): ContentTypeAction {
    return new ContentTypeAction({
      action: ContentTypeActionType.defineContentType,
      code,
      label,
      parentPath: options.parent === undefined ? undefined : toPath(options.parent),
      description: options.description,
      inheritAttributes: options.inheritAttributes,
    })
  }

  /**
   * Delete a node and its subtree, the batch form of {@link ContentType.undefine}.
   *
   * @param contentType - The node to delete, or its path.
   * @returns The action, unsent.
   */
  static undefine(contentType: PathRef): ContentTypeAction {
    return new ContentTypeAction({
      action: ContentTypeActionType.undefineContentType,
      contentTypePath: toPath(contentType),
    })
  }

  /**
   * Add an attribute, the batch form of {@link ContentType.defineAttribute}.
   *
   * @param contentType - The node to define it on, or its path.
   * @param name - Attribute identifier, snake_case.
   * @param attributeType - An {@link AttributeType}, or the equivalent string.
   * @param options - Choices, label, description and whether it is required.
   * @returns The action, unsent.
   * @throws Error - If a `select`/`multi-select` is missing `choices`. The API rejects
   *   that with a 422 anyway; catching it here saves the round trip.
   */
  static defineAttribute(
    contentType: PathRef,
    name: string,
    attributeType: AttributeType | string,
    options: DefineAttributeOptions = {},
  ): ContentTypeAction {
    // ponytail: the canonical values only. The API also accepts the `multiselect` and
    // `multi_select` aliases; those reach its 422 rather than a hand-kept copy of a
    // vocabulary the SDK does not own.
    const needsChoices =
      attributeType === AttributeType.select ||
      attributeType === AttributeType.multiSelect
    if (needsChoices && !options.choices?.length) {
      throw new Error(`${attributeType} needs choices`)
    }
    return new ContentTypeAction({
      action: ContentTypeActionType.defineAttribute,
      contentTypePath: toPath(contentType),
      name,
      attributeType,
      choices: options.choices && [...options.choices],
      label: options.label,
      description: options.description,
      required: options.required,
    })
  }

  /**
   * Remove an attribute, the batch form of {@link ContentType.undefineAttribute}.
   *
   * @param contentType - The node it is defined on, or its path.
   * @param name - Attribute identifier to remove.
   * @returns The action, unsent.
   */
  static undefineAttribute(contentType: PathRef, name: string): ContentTypeAction {
    return new ContentTypeAction({
      action: ContentTypeActionType.undefineAttribute,
      contentTypePath: toPath(contentType),
      name,
    })
  }
}

/**
 * The one place that knows a taxonomy action's wire names. The single-action operations
 * post exactly this too, so single and batch cannot drift. `compact` drops what is unset
 * and keeps `false`, which is a value.
 *
 * @internal
 */
export function contentTypeBody(action: ContentTypeAction): Record<string, unknown> {
  return compact({
    action: action.action,
    content_types: action.contentTypes,
    parent_path: action.parentPath,
    code: action.code,
    content_type_path: action.contentTypePath,
    label: action.label,
    description: action.description,
    inherit_attributes: action.inheritAttributes,
    name: action.name,
    attribute_type: action.attributeType,
    required: action.required,
    choices: action.choices,
  })
}

/**
 * One helper posts the action; the named operations just build it. Mirrors the facet
 * helper on `File`. Every action is idempotent server-side.
 */
function post(
  client: Transport,
  action: ContentTypeAction,
): Promise<Record<string, unknown>> {
  return client.request("POST", BASE, { json: contentTypeBody(action) })
}

export const ContentType = {
  /**
   * List the content-type taxonomy: top-level nodes, each carrying its `children`.
   *
   * @param client - The client to query with.
   * @param options - Subtree, depth, attribute and search filters.
   * @returns The top-level content-type nodes.
   */
  async list(
    client: Transport,
    options: ContentTypeListOptions = {},
  ): Promise<ContentType[]> {
    const data = await client.request<{ contentTypes: ContentType[] }>("GET", BASE, {
      params: compact({
        path: options.path,
        depth: options.depth,
        include_attributes: options.includeAttributes ?? false,
        query: options.query,
      }) as Query,
    })
    return data.contentTypes
  },

  /**
   * Rank the taxonomy against a question.
   *
   * Turns free text into the `contentType`/`attribute` filters `ask` and `search` take,
   * so a caller does not have to know the taxonomy by heart. Three modes, by option:
   *
   * - **prompt** (no `model`): scored content types plus `promptContext`, a ready-made
   *   prompt for your own LLM. No `completion`.
   * - **completion** (`model`): the API runs that LLM itself and returns the inferred
   *   scope in `completion`, attribute filters included.
   * - **catalog** (`relevanceScoring: "none"`): every content type at score 0. Pair it
   *   with `model` to infer over the whole taxonomy rather than the query-relevant slice.
   *
   * Nothing is stored: this is one stateless inference call.
   *
   * @param client - The client to query with.
   * @param query - The natural-language question (max 2000 chars). Omit it for the full
   *   schema catalog, which is what you want for a system prompt.
   * @param options - Result count, signal threshold, model and scoring mode.
   * @returns The resolved scope. Pass it to `ask`/`search` as `scope`, or read
   *   `filters()` yourself.
   * @throws Error - If `relevanceScoring` is anything but `"none"`, which the API rejects
   *   anyway; caught here to save the round trip.
   */
  async scope(
    client: Transport,
    query?: string,
    options: ContentTypeScopeOptions = {},
  ): Promise<FacetScope> {
    const scoring = options.relevanceScoring
    if (scoring !== undefined && scoring !== RelevanceScoring.none) {
      throw new Error(`scope() only accepts relevanceScoring: "none", got ${scoring}`)
    }
    const data = await client.request<ConstructorParameters<typeof FacetScope>[0]>(
      "POST",
      `${BASE}/scope`,
      {
        json: compact({
          query,
          max_results: options.maxResults,
          threshold: options.threshold,
          model: options.model,
          relevance_scoring: scoring,
        }),
      },
    )
    return new FacetScope(data)
  },

  /**
   * List the starter taxonomies you can {@link ContentType.adopt}.
   *
   * @param client - The client to query with.
   * @returns The template root nodes, each with its `children` and an `attributes` map
   *   covering the whole subtree.
   */
  async templates(client: Transport): Promise<Template[]> {
    const data = await client.request<{ contentTypes: Template[] }>(
      "GET",
      `${BASE}/templates`,
    )
    return data.contentTypes
  },

  /**
   * Import starter trees from the template catalog into your taxonomy.
   *
   * @param client - The client to write with.
   * @param paths - Template root paths to import, e.g. `["legal", "finance"]`.
   * @returns The imported top-level nodes.
   */
  async adopt(client: Transport, paths: readonly string[]): Promise<ContentType[]> {
    const data = (await post(client, ContentTypeAction.adopt(paths))) as {
      contentTypes: ContentType[]
    }
    return data.contentTypes
  },

  /**
   * Create or update one node.
   *
   * Idempotent: defining an existing code again updates it, so this is also how you
   * rename a node.
   *
   * @param client - The client to write with.
   * @param code - This node's own segment: lowercase alphanumeric with hyphens, e.g.
   *   `employment-contract`. The server rejects anything else.
   * @param label - Human-readable label.
   * @param options - Parent, description, and attribute inheritance.
   * @returns The created (or updated) node.
   */
  async define(
    client: Transport,
    code: string,
    label: string,
    options: DefineOptions = {},
  ): Promise<ContentType> {
    const node = await post(client, ContentTypeAction.define(code, label, options))
    return node as unknown as ContentType
  },

  /**
   * Delete a node **and cascade its whole subtree**.
   *
   * @param client - The client to write with.
   * @param contentType - The node to delete, or its path.
   */
  async undefine(client: Transport, contentType: PathRef): Promise<void> {
    await post(client, ContentTypeAction.undefine(contentType))
  },

  /**
   * Create or update an attribute column on a node.
   *
   * @param client - The client to write with.
   * @param contentType - The node to define it on, or its path.
   * @param name - Attribute identifier, snake_case.
   * @param attributeType - An {@link AttributeType}, or the equivalent string.
   * @param options - Choices, label, description and whether it is required.
   * @returns The created (or updated) attribute definition.
   * @throws Error - If a `select`/`multi-select` is missing `choices`. The API rejects
   *   that with a 422 anyway; catching it here saves the round trip.
   */
  async defineAttribute(
    client: Transport,
    contentType: PathRef,
    name: string,
    attributeType: AttributeType | string,
    options: DefineAttributeOptions = {},
  ): Promise<Attribute> {
    const attribute = await post(
      client,
      ContentTypeAction.defineAttribute(contentType, name, attributeType, options),
    )
    return attribute as unknown as Attribute
  },

  /**
   * Remove an attribute column from a node.
   *
   * @param client - The client to write with.
   * @param contentType - The node it is defined on, or its path.
   * @param name - Attribute identifier to remove.
   */
  async undefineAttribute(
    client: Transport,
    contentType: PathRef,
    name: string,
  ): Promise<void> {
    await post(client, ContentTypeAction.undefineAttribute(contentType, name))
  },

  /**
   * Apply up to 50 taxonomy actions in one request.
   *
   * The batch form of `adopt`/`define`/`undefine`/`defineAttribute`/`undefineAttribute`.
   * Build the list with {@link ContentTypeAction}, whose statics take the same arguments
   * as those operations, so a whole tree and its attributes land together:
   *
   * ```ts
   * await ContentType.batch(client, [
   *   ContentTypeAction.adopt(["legal"]),
   *   ContentTypeAction.defineAttribute("legal", "jurisdiction", AttributeType.select, {
   *     choices: ["FR", "US"],
   *   }),
   * ])
   * ```
   *
   * **Not transactional.** Field-level mistakes are caught up front, so a malformed
   * action applies nothing. A domain error (an unknown parent path, a permission denial)
   * stops at that action: everything before it is already applied, and the thrown error
   * carries its 0-based position on `.index`. Every action is idempotent, so correct that
   * one and resend the whole list.
   *
   * @param client - The client to write with.
   * @param actions - The actions, in order, at most 50. `ContentTypeAction`s, or raw wire
   *   bodies for a verb the SDK does not model yet, mixed freely. Empty is a local no-op.
   *   A longer job is yours to split: chunking here would report an index relative to a
   *   batch you never wrote.
   * @returns One result per action, in the order sent, so `results[i]` belongs to
   *   `actions[i]`. Only ever complete: a failure throws instead.
   * @throws Error - If more than 50 actions are passed (refused here to save the round
   *   trip).
   * @throws LightOnAPIError - If an action fails. `.index` is the one that did, and the
   *   actions before it are already applied.
   */
  async batch(
    client: Transport,
    actions: readonly (ContentTypeAction | Record<string, unknown>)[],
  ): Promise<ContentTypeResult[]> {
    if (actions.length === 0) return []
    if (actions.length > MAX_CONTENT_TYPE_ACTIONS) {
      throw new Error(
        `a batch takes at most ${MAX_CONTENT_TYPE_ACTIONS} actions, got ` +
          `${actions.length}; send them ${MAX_CONTENT_TYPE_ACTIONS} at a time`,
      )
    }
    const bodies = actions.map((a) =>
      a instanceof ContentTypeAction ? contentTypeBody(a) : a,
    )
    const data = await client.request<{ results: ContentTypeResult[] }>(
      "POST",
      `${BASE}/batch`,
      { json: { actions: bodies } },
    )
    return data.results
  },
}
