/**
 * Content types, attributes and facets.
 *
 * Three concepts, one shape each:
 * - a **content type** is a node in the company-wide taxonomy tree, e.g.
 *   `legal:contract:nda`. What kind of document this is.
 * - an **attribute** is a typed field on a content type, e.g. `jurisdiction`. What you
 *   can record.
 * - a **facet** is one content type assigned to one file, plus that file's values for
 *   its attributes. What this document actually is.
 */

/** A typed field on a content type. */
export interface Attribute {
  /** Attribute identifier, snake_case. */
  name: string
  label: string
  /** One of the {@link AttributeType} values. */
  type: string
  /** This file's value, on a facet; absent on a taxonomy definition. */
  value?: unknown
  required?: boolean
  /** Allowed values, for `select` and `multi-select`. */
  choices?: string[]
  description?: string
}

/** A content type assigned to a file, with that file's attribute values. */
export interface Facet {
  /** Content-type path, e.g. `legal:contract:nda`. */
  path: string
  label: string
  attributes: Attribute[]
}
