/** Shared helpers. */

import type { Query } from "./client.ts"

/**
 * Response keys whose *values* are copied through untouched.
 *
 * The SDK presents a camelCase surface over a snake_case wire, but three payloads are
 * not ours to rename:
 *
 * - `data`: extract result rows are shaped by the caller's own JSON Schema, so a
 *   `last_name` property must stay `last_name`. `ContentType.batch` results ride here
 *   too, and Python hands those back un-modelled for the same reason.
 * - `additional_metadata`: free-form, caller-controlled keys.
 * - `explain`: free-form scoring breakdown, present only when the server enables it.
 */
const OPAQUE = new Set(["data", "additional_metadata", "explain"])

/** `snake_case` to `camelCase`, at the type level. */
export type CamelKey<K extends string> = K extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<CamelKey<Tail>>}`
  : K

type OpaqueKey = "data" | "additional_metadata" | "explain"

/** Deeply rewrite an object's keys to camelCase, leaving {@link OPAQUE} values alone. */
export type Camelize<T> = T extends readonly (infer Element)[]
  ? Camelize<Element>[]
  : T extends object
    ? {
        [K in keyof T as K extends string ? CamelKey<K> : K]: K extends OpaqueKey
          ? T[K]
          : Camelize<T[K]>
      }
    : T

/** `snake_case` to `camelCase`. Leading underscores and digits are left alone. */
export function toCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase())
}

/**
 * Deeply rewrite an object's keys to camelCase.
 *
 * Applied once, in the transport, so every response reaches callers in the SDK's
 * naming. Values under an {@link OPAQUE} key are copied as-is.
 *
 * @param value - Any parsed JSON value.
 * @returns The same shape with camelCase keys.
 */
export function camelize<T>(value: T): Camelize<T> {
  return convert(value) as Camelize<T>
}

function convert(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(convert)
  if (typeof value !== "object" || value === null) return value
  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value)) {
    out[toCamel(key)] = OPAQUE.has(key) ? inner : convert(inner)
  }
  return out
}

/** Something carrying a server-assigned numeric id, or the bare id. */
export type IdRef = number | { readonly id: number | string | null }
/** A content type, or its path string. */
export type PathRef = string | { readonly path: string }

/** Request body from an object, dropping nullish so the server applies its defaults. */
export function compact<T extends Record<string, unknown>>(
  values: T,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) out[key] = value
  }
  return out
}

/** Coerce a resource or a bare id to its id. */
export function id(item: IdRef): number | string {
  if (typeof item === "number") return item
  if (item.id === null) throw new Error("resource must be created or retrieved first")
  return item.id
}

/** Coerce resources or bare ids to a list of ids. */
export function ids(
  items: readonly IdRef[] | undefined,
): (number | string)[] | undefined {
  return items?.map(id)
}

/** Coerce a content type or a path string to its path. */
export function path(item: PathRef): string {
  return typeof item === "string" ? item : item.path
}

/** Coerce content types or path strings to a list of paths. */
export function paths(items: readonly PathRef[] | undefined): string[] | undefined {
  return items?.map(path)
}

/** A page of a paginated list endpoint. */
interface PaginatedPage<T> {
  results: T[]
  next?: string | null
}

/**
 * Fetch every page of a paginated endpoint, following `next` to the end.
 *
 * No silent truncation: a caller asking to list gets everything. The query is sent on
 * the first request only, because `next` is an absolute URL already carrying it.
 *
 * @param transport - The client to send through.
 * @param base - Path under the base URL, e.g. `/api/v3/tags`.
 * @param params - Optional query filters, sent on the first page.
 * @returns Every row, in server order.
 */
export async function paginate<T>(
  transport: {
    request<R>(method: string, path: string, options?: { params?: Query }): Promise<R>
  },
  base: string,
  params?: Query,
): Promise<T[]> {
  const items: T[] = []
  let next: string | null = base
  let query = params
  while (next) {
    const page: PaginatedPage<T> = await transport.request<PaginatedPage<T>>(
      "GET",
      next,
      query ? { params: query } : {},
    )
    items.push(...page.results)
    next = page.next ?? null
    query = undefined // `next` already carries the query string
  }
  return items
}
