/**
 * Type-level checks on the camelCase boundary.
 *
 * The whole naming decision rests on `Camelize` rewriting the generated snake_case
 * types, so it is asserted against the real ones rather than a hand-made sample.
 */

import { expectTypeOf, test } from "vitest"
import { ContentTypeAction, FacetAction } from "../src/contentType.ts"
import type {
  AskResultItem,
  ExtractJobResponse,
  ParseResponse,
  SearchResultItem,
} from "../src/types/index.ts"
import type { Camelize } from "../src/utils.ts"

test("response keys are camelCase", () => {
  expectTypeOf<ParseResponse>().toHaveProperty("processingTimeMs")
  expectTypeOf<ParseResponse>().toHaveProperty("completedAt")
  expectTypeOf<AskResultItem>().toHaveProperty("chunkId")
  expectTypeOf<SearchResultItem>().toHaveProperty("chunkId")
})

test("nested shapes are camelized too", () => {
  expectTypeOf<ParseResponse["usage"]>().toHaveProperty("pagesProcessed")
  expectTypeOf<ParseResponse["result"]["pages"][number]>().toHaveProperty("index")
})

test("extracted rows keep the caller's own keys", () => {
  // `data` is opaque: renaming its keys would corrupt results shaped by a user schema.
  type Row = NonNullable<NonNullable<ExtractJobResponse["result"]>["data"]>
  expectTypeOf<Camelize<{ data: { last_name: string } }>>().toEqualTypeOf<{
    data: { last_name: string }
  }>()
  expectTypeOf<Row>().not.toBeNever()
})

test("a FacetAction is only built through its statics", () => {
  // The counterpart of pydantic's validator and `extra="forbid"`: a hand-built action
  // could drop `attributeName` from a value verb, or misspell a field.
  // @ts-expect-error the constructor is private
  expectTypeOf(new FacetAction("set_value", "legal")).not.toBeNever()
})

test("a ContentTypeAction is only built through its statics", () => {
  // Same reason: a `define` without its `label`, or a misspelled field, cannot be built.
  // @ts-expect-error the constructor is private
  expectTypeOf(new ContentTypeAction({ action: "define_content_type" })).not.toBeNever()
})

test("optionality survives the rewrite", () => {
  expectTypeOf<Camelize<{ a_b?: string }>>().toEqualTypeOf<{ aB?: string }>()
})

test("multi-underscore keys fold left to right", () => {
  expectTypeOf<Camelize<{ endpoint_category_names: string[] }>>().toEqualTypeOf<{
    endpointCategoryNames: string[]
  }>()
})

test("create() promises a persisted id, so callers need no non-null assertion", async () => {
  // Without this, `Workspace.get(client, ws.id)` on the very next line does not compile,
  // because `id` is nullable on a fresh instance. create() either sets it or throws.
  const { LightOn } = await import("../src/client.ts")
  const { Workspace } = await import("../src/workspace.ts")
  const { ApiKey } = await import("../src/apikey.ts")
  const client = new LightOn("k")

  expectTypeOf(new Workspace({ name: "a" }).create(client)).resolves.toExtend<{
    id: number
  }>()
  expectTypeOf(new ApiKey({ name: "a" }).create(client)).resolves.toExtend<{
    id: string
  }>()
})

test("list filters are typed from the schema, and refuse `page`", async () => {
  const { File } = await import("../src/file.ts")
  const { LightOn } = await import("../src/client.ts")
  const client = new LightOn("k")
  type Options = NonNullable<Parameters<typeof File.list>[1]>
  type Filters = NonNullable<Options["filters"]>

  expectTypeOf<Filters>().toHaveProperty("external_metadata__external_id")
  expectTypeOf<Filters>().toHaveProperty("page_size")
  expectTypeOf<Filters>().not.toHaveProperty("page")

  // An unknown status is a type error, not a silently empty listing.
  // @ts-expect-error "embeded" is not a status the API accepts
  void File.list(client, { filters: { status: "embeded" } })
})
