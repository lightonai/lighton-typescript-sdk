import { expect, test } from "vitest"
import {
  ContentType,
  ContentTypeAction,
  MAX_CONTENT_TYPE_ACTIONS,
} from "../src/contentType.ts"
import { AttributeType } from "../src/enums.ts"
import { NotFoundError } from "../src/errors.ts"
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
  // The canonical strings too, which the members are. The API's aliases (`multiselect`)
  // are deliberately not matched: they reach its 422.
  for (const kind of ["select", "multi-select"]) {
    await expect(
      ContentType.defineAttribute(client, "legal", "x", kind),
    ).rejects.toThrow(/needs choices/)
  }
  // The batch form refuses it too, at build time.
  expect(() =>
    ContentTypeAction.defineAttribute("legal", "x", AttributeType.select),
  ).toThrow(/select needs choices/)
  expect(calls).toBe(0)
})

test("a false flag is sent, not dropped", async () => {
  // False is a value, not unset. Dropped, the server would apply its default of true and
  // silently inherit attributes the caller asked it not to; and it would vanish from the
  // batch path identically, so the single-equals-batch test alone would stay green.
  const define = await sent((c) =>
    ContentType.define(c, "x", "X", { inheritAttributes: false }),
  )
  expect(define.body.inherit_attributes).toBe(false)

  const attribute = await sent((c) =>
    ContentType.defineAttribute(c, "legal", "region", AttributeType.text, {
      required: false,
    }),
  )
  expect(attribute.body.required).toBe(false)

  const batch = await sent(
    (c) =>
      ContentType.batch(c, [
        ContentTypeAction.define("x", "X", { inheritAttributes: false }),
        ContentTypeAction.defineAttribute("legal", "region", AttributeType.text, {
          required: false,
        }),
      ]),
    {
      results: [
        { status: 201, data: null },
        { status: 201, data: null },
      ],
    },
  )
  const [first, second] = batch.body.actions as Record<string, unknown>[]
  expect(first?.inherit_attributes).toBe(false)
  expect(second?.required).toBe(false)
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

const noRequest = (request: Request): Response => {
  throw new Error(`no request should be made, got ${request.url}`)
}

/** `count` results of one status, the shape a successful batch answers with. */
const ok = (count: number, status = 200) => ({
  results: Array(count).fill({ status, data: null }),
})

test("batch posts every action in one request", async () => {
  const requests: { path: string; body: unknown }[] = []
  const client = makeClient(async (request) => {
    requests.push({ path: new URL(request.url).pathname, body: await request.json() })
    return json(ok(2, 201))
  })
  await ContentType.batch(client, [
    ContentTypeAction.adopt(["legal"]),
    ContentTypeAction.defineAttribute("legal", "flag", AttributeType.boolean),
  ])
  expect(requests, "a batch must be exactly one round trip").toHaveLength(1)
  expect(requests[0]?.path).toBe("/api/v3/content-types/batch")
  expect(requests[0]?.body).toEqual({
    actions: [
      { action: "adopt", content_types: ["legal"] },
      {
        action: "define_attribute",
        content_type_path: "legal",
        name: "flag",
        attribute_type: "boolean",
      },
    ],
  })
})

test("batch sends the same bodies as the single-action methods", async () => {
  // One wire encoder behind both paths, so they cannot drift apart.
  const single: unknown[] = []
  const batched: unknown[] = []
  const client = makeClient(async (request) => {
    const body = (await request.json()) as { actions?: unknown[] }
    if (request.url.endsWith("/batch")) {
      batched.push(...(body.actions ?? []))
      return json(ok(5))
    }
    single.push(body)
    return json({ content_types: [] })
  })
  await ContentType.adopt(client, ["legal"])
  await ContentType.define(client, "nda", "NDA", {
    parent: "legal",
    inheritAttributes: false,
  })
  await ContentType.defineAttribute(client, "legal", "region", AttributeType.select, {
    choices: ["FR"],
    required: false,
  })
  await ContentType.undefineAttribute(client, "legal", "region")
  await ContentType.undefine(client, "legal")
  await ContentType.batch(client, [
    ContentTypeAction.adopt(["legal"]),
    ContentTypeAction.define("nda", "NDA", {
      parent: "legal",
      inheritAttributes: false,
    }),
    ContentTypeAction.defineAttribute("legal", "region", AttributeType.select, {
      choices: ["FR"],
      required: false,
    }),
    ContentTypeAction.undefineAttribute("legal", "region"),
    ContentTypeAction.undefine("legal"),
  ])
  expect(single).toEqual(batched)
})

test("batch returns one result per action, in order", async () => {
  const client = makeClient(() =>
    json({
      results: [
        { status: 201, data: { path: "compliance" } },
        { status: 204, data: null },
        { status: 200, data: { name: "owner", type: "text" } },
      ],
    }),
  )
  const results = await ContentType.batch(client, [
    ContentTypeAction.define("compliance", "Compliance"),
    ContentTypeAction.undefineAttribute("compliance", "stale"),
    ContentTypeAction.defineAttribute("compliance", "owner", AttributeType.text),
  ])
  expect(results.map((r) => r.status)).toEqual([201, 204, 200])
  expect(results[1]?.data, "the 204 verbs carry no data").toBeNull()
  expect(results[2]?.data).toEqual({ name: "owner", type: "text" })
})

test("batch refuses more than fifty actions, and accepts fifty", async () => {
  const action = ContentTypeAction.undefine("legal")
  await expect(
    ContentType.batch(
      makeClient(noRequest),
      Array(MAX_CONTENT_TYPE_ACTIONS + 1).fill(action),
    ),
  ).rejects.toThrow(/at most 50/)

  // The boundary itself is accepted: an off-by-one is the plausible bug here.
  const client = makeClient(() => json(ok(MAX_CONTENT_TYPE_ACTIONS, 204)))
  const results = await ContentType.batch(
    client,
    Array(MAX_CONTENT_TYPE_ACTIONS).fill(action),
  )
  expect(results).toHaveLength(MAX_CONTENT_TYPE_ACTIONS)
})

test("batch on an empty list is a local no-op", async () => {
  expect(await ContentType.batch(makeClient(noRequest), [])).toEqual([])
})

test("batch passes raw action bodies through untouched", async () => {
  const raw = { action: "some_future_verb", content_type_path: "legal", extra: 1 }
  const { body } = await sent(
    (c) => ContentType.batch(c, [ContentTypeAction.undefine("legal"), raw]),
    ok(2),
  )
  expect(
    (body.actions as unknown[])[1],
    "a raw body must reach the wire untouched",
  ).toEqual(raw)
})

test("batch reports the failing action's index on the status-mapped error", async () => {
  // `index` rides on the usual class, so `instanceof NotFoundError` still works.
  const client = makeClient(() => json({ detail: "unknown parent", index: 1 }, 404))
  const actions = [
    ContentTypeAction.define("compliance", "Compliance"),
    ContentTypeAction.define("audit", "Audit", { parent: "nope:not-a-type" }),
  ]
  const error = (await ContentType.batch(client, actions).catch(
    (e: unknown) => e,
  )) as NotFoundError
  expect(error).toBeInstanceOf(NotFoundError)
  expect(error.index).toBe(1)
  expect(error.message, "the position belongs in the message too").toContain("action 1")
  // Which is what makes the offender addressable; the prefix is already applied.
  expect(actions[error.index ?? -1]?.parentPath).toBe("nope:not-a-type")
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
