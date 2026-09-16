/**
 * Guided-generation schemas, shared by `extract` (the extraction target) and `ask`
 * (`schema`, which constrains the answer and is sent as the API's `response_format`).
 *
 * The endpoints reject `$ref`, so every schema goes through {@link normalizeJsonSchema},
 * whether it arrived as a plain object or came out of Zod, which emits `$defs`/`$ref` for
 * every reused sub-schema just as pydantic does.
 */

const DRAFT = "https://json-schema.org/draft/2020-12/schema"

/** A JSON Schema, as a plain object. */
export type JsonSchema = Record<string, unknown>

/** The shape Zod exposes to schema-agnostic consumers, via the Standard Schema spec. */
interface StandardSchemaLike {
  "~standard": { vendor: string; version: number }
}

/**
 * Either input `ask` and `extract` accept for guided generation.
 *
 * A Zod schema is converted with Zod's own `toJSONSchema`, imported only when one is
 * actually passed, so `zod` stays an optional peer dependency that costs nothing to
 * callers who hand over a plain JSON Schema instead.
 */
export type SchemaInput = JsonSchema | StandardSchemaLike

function isStandardSchema(schema: SchemaInput): schema is StandardSchemaLike {
  return (
    typeof schema === "object" &&
    schema !== null &&
    "~standard" in schema &&
    typeof (schema as StandardSchemaLike)["~standard"] === "object"
  )
}

function isPlainObject(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Replace every `$ref` into `$defs` with the resolved subschema, inline.
 *
 * vLLM's guided-generation grammar wants a self-contained schema, so `$defs`/`$ref` are
 * flattened away. Sibling keywords on the ref (e.g. `description`) win over the resolved
 * target.
 *
 * ponytail: recurses through refs, so a self-referential schema blows the stack. Guided
 * generation can't express unbounded recursion anyway; add a seen-set guard if such a
 * schema ever needs to reach here.
 */
function inlineRefs(node: unknown, defs: Record<string, unknown>): unknown {
  if (Array.isArray(node)) return node.map((item) => inlineRefs(item, defs))
  if (!isPlainObject(node)) return node

  const ref = node.$ref
  if (typeof ref === "string" && ref.startsWith("#/$defs/")) {
    const name = ref.slice("#/$defs/".length)
    if (!(name in defs)) {
      throw new TypeError(
        `unresolved $ref ${JSON.stringify(ref)}: no such entry in $defs`,
      )
    }
    const siblings: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node)) {
      if (key !== "$ref") siblings[key] = inlineRefs(value, defs)
    }
    return { ...(inlineRefs(defs[name], defs) as JsonSchema), ...siblings }
  }

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) out[key] = inlineRefs(value, defs)
  return out
}

/**
 * Rewrite `anyOf: [{type: X}, {type: "null"}]` as `type: [X, "null"]`.
 *
 * Matches the shape vLLM examples use. Only collapses when every branch is a bare
 * `{type: ...}`: a branch carrying `format` or `enum` can't fold into a type array, so
 * it is left as `anyOf`.
 */
function collapseNullable(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(collapseNullable)
  if (!isPlainObject(node)) return node

  const branches = node.anyOf
  const foldable =
    Array.isArray(branches) &&
    branches.length > 0 &&
    branches.every(
      (branch) =>
        isPlainObject(branch) && Object.keys(branch).length === 1 && "type" in branch,
    )

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === "anyOf" && foldable) continue
    out[key] = collapseNullable(value)
  }
  if (foldable) {
    out.type = (branches as JsonSchema[]).map((branch) => branch.type)
  }
  return out
}

/**
 * Normalize a JSON Schema into the self-contained shape vLLM wants.
 *
 * `$defs`/`$ref` inlined, nullable `anyOf` collapsed to `type: [X, "null"]`, and the
 * draft-2020-12 `$schema` marker added (an existing one is kept).
 *
 * @param schema - A JSON Schema, possibly carrying `$defs`/`$ref`.
 * @returns An equivalent self-contained schema, free of `$defs` and `$ref`.
 * @throws TypeError - If a `#/$defs/` ref has no target.
 */
export function normalizeJsonSchema(schema: JsonSchema): JsonSchema {
  const defs = isPlainObject(schema.$defs) ? schema.$defs : {}
  const withoutDefs: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key !== "$defs") withoutDefs[key] = value
  }
  const inlined = collapseNullable(inlineRefs(withoutDefs, defs)) as JsonSchema
  return { $schema: DRAFT, ...inlined }
}

/**
 * Either guided-generation input, as the self-contained schema to send.
 *
 * @param schema - A Zod schema, or a plain object holding a JSON Schema.
 * @returns A self-contained JSON Schema, free of `$defs` and `$ref`.
 * @throws TypeError - If `schema` is neither.
 */
export async function asJsonSchema(schema: SchemaInput): Promise<JsonSchema> {
  if (isStandardSchema(schema)) {
    const vendor = schema["~standard"].vendor
    if (vendor !== "zod") {
      throw new TypeError(
        `unsupported schema library ${JSON.stringify(vendor)}: pass a Zod schema or a plain JSON Schema object`,
      )
    }
    // Imported only when a Zod schema is actually handed over, which is what keeps zod
    // an optional peer dependency rather than a runtime one.
    const { toJSONSchema } = await import("zod")
    const converted = toJSONSchema(schema as never, {
      target: "draft-2020-12",
      io: "output",
    }) as JsonSchema
    return normalizeJsonSchema(converted)
  }
  if (isPlainObject(schema)) return normalizeJsonSchema(schema)
  throw new TypeError("schema must be a Zod schema or a plain JSON Schema object")
}
