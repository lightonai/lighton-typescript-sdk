/**
 * Type-level checks on the camelCase boundary.
 *
 * The whole naming decision rests on `Camelize` rewriting the generated snake_case
 * types, so it is asserted against the real ones rather than a hand-made sample.
 */

import { expectTypeOf, test } from "vitest"
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
