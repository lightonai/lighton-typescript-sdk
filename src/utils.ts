/** Shared helpers. */

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
