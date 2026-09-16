import { expect, test } from "vitest"
import { ActiveRecord } from "../src/activeRecord.ts"
import { resolveTagIds, Tag } from "../src/tag.ts"
import { json, makeClient } from "./helpers.ts"

test("create posts name, description and autoAssign", async () => {
  let body: Record<string, unknown> = {}
  const client = makeClient(async (request) => {
    body = (await request.json()) as Record<string, unknown>
    return json({ id: 7, name: "contracts", document_count: 0 })
  })
  const tag = await new Tag({ name: "contracts", description: "Signed" }).create(client)
  expect(body).toEqual({
    name: "contracts",
    description: "Signed",
    auto_assign: true,
  })
  expect(tag.id).toBe(7)
  expect(tag.documentCount).toBe(0)
})

test("list follows pagination", async () => {
  const pages = [
    {
      results: [{ id: 1, name: "a" }],
      next: "https://api.lighton.ai/api/v3/tags?page=2",
    },
    { results: [{ id: 2, name: "b" }], next: null },
  ]
  let call = 0
  const client = makeClient(() => json(pages[call++] as unknown))
  expect((await Tag.list(client)).map((t) => t.name)).toEqual(["a", "b"])
})

test("get and refresh throw, the tags API has no single-tag GET", async () => {
  // Better a clear message at the call site than a 404 from a URL that never existed.
  const client = makeClient(() => json({}))
  expect(() => Tag.get()).toThrow(/no single-tag GET/)
  const tag = ActiveRecord.hydrate(Tag, client, { id: 1, name: "a" })
  expect(() => tag.refresh()).toThrow(/no single-tag GET/)
})

test("delete still works and clears the id", async () => {
  const client = makeClient(() => new Response(null, { status: 204 }))
  const tag = ActiveRecord.hydrate(Tag, client, { id: 1, name: "a" })
  await tag.delete()
  expect(tag.id).toBeNull()
})

test("resolveTagIds mixes objects, ids and names", async () => {
  const client = makeClient(() =>
    json({
      results: [
        { id: 1, name: "legal" },
        { id: 2, name: "hr" },
      ],
    }),
  )
  const tag = ActiveRecord.hydrate(Tag, client, { id: 9, name: "saved" })
  expect(await resolveTagIds(client, [tag, 5, "legal"])).toEqual([9, 5, 1])
})

test("resolveTagIds refuses an unsaved Tag", async () => {
  const client = makeClient(() => json({ results: [] }))
  await expect(resolveTagIds(client, [new Tag({ name: "fresh" })])).rejects.toThrow(
    /cannot resolve an unsaved Tag/,
  )
})
