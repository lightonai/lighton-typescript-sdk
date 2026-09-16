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
 */

import type { Query, Transport } from "./client.ts"
import { AttributeType } from "./enums.ts"
import { compact, type PathRef, path as toPath } from "./utils.ts"

const BASE = "/api/v3/content-types"

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

/** One result of a {@link ContentType.batch} call. */
export interface BatchActionResult {
  /** HTTP status this action would have returned on its own. */
  status: number
  /**
   * The node or attribute the action produced.
   *
   * Left as-is, including its wire naming: `data` is one of the opaque keys the
   * camelCase boundary does not rewrite, because which shape it holds depends on the
   * action. Reach for the single-action methods when you want a typed result.
   */
  data?: unknown
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
 * One helper posts the action; the named operations just name their fields. Mirrors the
 * facet helper on `File`. Every action is idempotent server-side.
 */
function action(
  client: Transport,
  name: string,
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return client.request("POST", BASE, { json: compact({ action: name, ...fields }) })
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
    const data = (await action(client, "adopt", { content_types: [...paths] })) as {
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
    const node = await action(client, "define_content_type", {
      code,
      label,
      parent_path: options.parent === undefined ? undefined : toPath(options.parent),
      description: options.description,
      inherit_attributes: options.inheritAttributes,
    })
    return node as unknown as ContentType
  },

  /**
   * Delete a node **and cascade its whole subtree**.
   *
   * @param client - The client to write with.
   * @param contentType - The node to delete, or its path.
   */
  async undefine(client: Transport, contentType: PathRef): Promise<void> {
    await action(client, "undefine_content_type", {
      content_type_path: toPath(contentType),
    })
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
    const needsChoices =
      attributeType === AttributeType.select ||
      attributeType === AttributeType.multiSelect
    if (needsChoices && !options.choices?.length) {
      throw new Error(`${attributeType} needs choices`)
    }
    const attribute = await action(client, "define_attribute", {
      content_type_path: toPath(contentType),
      name,
      attribute_type: attributeType,
      choices: options.choices,
      label: options.label,
      description: options.description,
      required: options.required,
    })
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
    await action(client, "undefine_attribute", {
      content_type_path: toPath(contentType),
      name,
    })
  },

  /**
   * Apply several taxonomy actions in one request.
   *
   * Each entry is the body a single-action method would send, so a tree and its
   * attributes land together instead of one round trip each:
   *
   * ```ts
   * await ContentType.batch(client, [
   *   { action: "adopt", content_types: ["legal"] },
   *   {
   *     action: "define_attribute",
   *     content_type_path: "legal",
   *     name: "jurisdiction",
   *     attribute_type: "select",
   *     choices: ["FR", "US"],
   *   },
   * ])
   * ```
   *
   * The entries are wire bodies, so their keys are the server's, not the SDK's.
   *
   * @param client - The client to write with.
   * @param actions - The action bodies, in order.
   * @returns One result per action, in the same order.
   */
  async batch(
    client: Transport,
    actions: readonly Record<string, unknown>[],
  ): Promise<BatchActionResult[]> {
    const data = await client.request<{ results: BatchActionResult[] }>(
      "POST",
      `${BASE}/batch`,
      { json: { actions: [...actions] } },
    )
    return data.results
  },
}
