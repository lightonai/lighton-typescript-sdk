import { expect, test } from "vitest"
import { ContentType } from "../src/contentType.ts"
import { AttributeType } from "../src/enums.ts"
import { json, makeClient } from "./helpers.ts"

const TREE = {
  content_types: [
    {
      path: "legal",
      code: "legal",
      label: "Legal",
      children: [{ path: "legal:contract", code: "contract", label: "Contract" }],
      attributes: [
        {
          name: "jurisdiction",
          type: "select",
          choices: ["FR", "US"],
          required: false,
        },
      ],
    },
  ],
}

async function sent(
  run: (client: ReturnType<typeof makeClient>) => Promise<unknown>,
  respond: unknown = {},
): Promise<{ body: Record<string, unknown>; url: string; method: string }> {
  let body: Record<string, unknown> = {}
  let url = ""
  let method = ""
  const client = makeClient(async (request) => {
    url = request.url
    method = request.method
    if (request.method !== "GET")
      body = (await request.json()) as Record<string, unknown>
    return json(respond)
  })
  await run(client)
  return { body, url, method }
}

// --- reads ------------------------------------------------------------------

test("list returns the top-level nodes, each carrying its children", async () => {
  const client = makeClient(() => json(TREE))
  const roots = await ContentType.list(client)
  expect(roots).toHaveLength(1)
  expect(roots[0]?.path).toBe("legal")
  expect(roots[0]?.children?.[0]?.path).toBe("legal:contract")
  expect(roots[0]?.attributes?.[0]?.choices).toEqual(["FR", "US"])
})

test("list passes its filters as query params", async () => {
  const { url } = await sent(
    (c) =>
      ContentType.list(c, {
        path: "legal",
        depth: 2,
        includeAttributes: true,
        query: "nda",
      }),
    TREE,
  )
  expect(url).toContain("path=legal")
  expect(url).toContain("depth=2")
  expect(url).toContain("include_attributes=true")
  expect(url).toContain("query=nda")
})

test("includeAttributes defaults to false and is always sent", async () => {
  const { url } = await sent((c) => ContentType.list(c), TREE)
  expect(url).toContain("include_attributes=false")
})

test("templates hang the whole subtree's attributes off the root as a map", async () => {
  // The one shape that differs from a live node: a path-keyed map, not a flat list.
  const client = makeClient(() =>
    json({
      content_types: [
        {
          path: "legal",
          code: "legal",
          label: "Legal",
          attributes: {
            legal: [{ name: "jurisdiction", type: "select" }],
            "legal:contract": [{ name: "signed_on", type: "date" }],
          },
        },
      ],
    }),
  )
  const [template] = await ContentType.templates(client)
  expect(Object.keys(template?.attributes ?? {})).toEqual(["legal", "legal:contract"])
  expect(template?.attributes?.["legal:contract"]?.[0]?.name).toBe("signed_on")
})

// --- writes -----------------------------------------------------------------

test("adopt imports template roots", async () => {
  const { body } = await sent((c) => ContentType.adopt(c, ["legal", "finance"]), TREE)
  expect(body).toEqual({ action: "adopt", content_types: ["legal", "finance"] })
})

test("define posts a root node with no parent path", async () => {
  const { body } = await sent((c) => ContentType.define(c, "compliance", "Compliance"))
  expect(body).toEqual({
    action: "define_content_type",
    code: "compliance",
    label: "Compliance",
  })
})

test("define accepts a parent node or a parent path", async () => {
  const fromPath = await sent((c) =>
    ContentType.define(c, "nda", "NDA", { parent: "legal:contract" }),
  )
  expect(fromPath.body.parent_path).toBe("legal:contract")

  const contract: ContentType = {
    path: "legal:contract",
    code: "contract",
    label: "Contract",
  }
  const fromNode = await sent((c) =>
    ContentType.define(c, "nda", "NDA", { parent: contract, inheritAttributes: false }),
  )
  expect(fromNode.body.parent_path).toBe("legal:contract")
  expect(fromNode.body.inherit_attributes).toBe(false)
})

test("undefine cascades the whole subtree", async () => {
  const { body } = await sent((c) => ContentType.undefine(c, "compliance"))
  expect(body).toEqual({
    action: "undefine_content_type",
    content_type_path: "compliance",
  })
})

test("defineAttribute maps camelCase options onto wire names", async () => {
  const { body } = await sent((c) =>
    ContentType.defineAttribute(c, "legal", "fiscal_year", AttributeType.number, {
      label: "Fiscal Year",
      required: true,
    }),
  )
  expect(body).toEqual({
    action: "define_attribute",
    content_type_path: "legal",
    name: "fiscal_year",
    attribute_type: "number",
    label: "Fiscal Year",
    required: true,
  })
})

test("a select without choices is rejected client-side, saving a round trip", async () => {
  // The API rejects it with 422 anyway; failing here keeps the error at the call site.
  let calls = 0
  const client = makeClient(() => {
    calls += 1
    return json({})
  })
  await expect(
    ContentType.defineAttribute(client, "legal", "jurisdiction", AttributeType.select),
  ).rejects.toThrow(/select needs choices/)
  await expect(
    ContentType.defineAttribute(client, "legal", "tags", AttributeType.multiSelect, {
      choices: [],
    }),
  ).rejects.toThrow(/multi-select needs choices/)
  expect(calls).toBe(0)
})

test("other attribute types need no choices", async () => {
  const { body } = await sent((c) =>
    ContentType.defineAttribute(c, "legal", "signed_on", AttributeType.date),
  )
  expect(body.attribute_type).toBe("date")
  expect(body.choices).toBeUndefined()
})

test("undefineAttribute removes one column", async () => {
  const { body } = await sent((c) =>
    ContentType.undefineAttribute(c, "legal", "fiscal_year"),
  )
  expect(body).toEqual({
    action: "undefine_attribute",
    content_type_path: "legal",
    name: "fiscal_year",
  })
})

// --- batch ------------------------------------------------------------------

test("batch sends the actions in order and returns one result each", async () => {
  const { body, url } = await sent(
    (c) =>
      ContentType.batch(c, [
        { action: "adopt", content_types: ["legal"] },
        {
          action: "define_attribute",
          content_type_path: "legal",
          name: "jurisdiction",
          attribute_type: "select",
          choices: ["FR", "US"],
        },
      ]),
    { results: [{ status: 201 }, { status: 201 }] },
  )
  expect(url).toContain("/api/v3/content-types/batch")
  expect((body.actions as unknown[]).length).toBe(2)
})

test("batch results keep their payload in the server's own naming", async () => {
  // `data` is an opaque key: which shape it holds depends on the action, so it is handed
  // back untouched rather than guessed into one model. Matches the Python SDK.
  const client = makeClient(() =>
    json({
      results: [
        {
          status: 201,
          data: { path: "legal", code: "legal", inherit_attributes: true },
        },
      ],
    }),
  )
  const [result] = await ContentType.batch(client, [{ action: "adopt" }])
  expect(result?.status).toBe(201)
  expect(result?.data).toEqual({
    path: "legal",
    code: "legal",
    inherit_attributes: true,
  })
})

// --- interop with File ------------------------------------------------------

test("a node can be passed straight to file.classify", async () => {
  const { File } = await import("../src/file.ts")
  const { ActiveRecord } = await import("../src/activeRecord.ts")
  let body: Record<string, unknown> = {}
  const client = makeClient(async (request) => {
    body = (await request.json()) as Record<string, unknown>
    return json({})
  })
  const node: ContentType = { path: "legal:contract:nda", code: "nda", label: "NDA" }
  await ActiveRecord.hydrate(File, client, { id: 7 }).classify(node)
  expect(body.content_type_path).toBe("legal:contract:nda")
})
