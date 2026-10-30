import { expect, test } from "vitest"
import { RelevanceScoring, SearchMode } from "../src/enums.ts"
import { json, makeClient, RESOLVED_SCOPE, SCOPE } from "./helpers.ts"

const EMPTY = { results: [] }

async function bodyOf(
  run: (client: ReturnType<typeof makeClient>) => Promise<unknown>,
  respond: unknown = EMPTY,
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {}
  const client = makeClient(async (request) => {
    body = (await request.json()) as Record<string, unknown>
    return json(respond)
  })
  await run(client)
  return body
}

test("sends the query and nothing else by default", async () => {
  expect(await bodyOf((c) => c.search("termination clause"))).toEqual({
    query: "termination clause",
  })
})

test("maps camelCase options onto wire names", async () => {
  const body = await bodyOf((c) =>
    c.search("q", {
      workspaces: [42],
      maxResults: 20,
      mode: SearchMode.vision,
      relevanceScoring: RelevanceScoring.scoringOnly,
      includeImage: true,
      includeBboxes: false,
    }),
  )
  expect(body).toEqual({
    query: "q",
    workspace_id: [42],
    max_results: 20,
    mode: "vision",
    relevance_scoring: "scoring_only",
    include_image: true,
    include_bboxes: false,
  })
})

test("accepts resources or bare ids, interchangeably", async () => {
  const body = await bodyOf((c) =>
    c.search("q", { workspaces: [{ id: 42 }, 7], files: [{ id: 1 }] }),
  )
  expect(body.workspace_id).toEqual([42, 7])
  expect(body.file_id).toEqual([1])
})

test("accepts content types as objects or path strings", async () => {
  const body = await bodyOf((c) =>
    c.search("q", { contentType: ["legal:contract", { path: "finance" }] }),
  )
  expect(body.content_type).toEqual(["legal:contract", "finance"])
})

test("passes attribute filters through untouched", async () => {
  // These are a filter grammar, not field names; camelizing them would break the query.
  const body = await bodyOf((c) =>
    c.search("q", { attribute: ["fiscal_year:2024|2025", "status:active"] }),
  )
  expect(body.attribute).toEqual(["fiscal_year:2024|2025", "status:active"])
})

test("camelizes the response", async () => {
  const client = makeClient(() =>
    json({
      results: [{ chunk_id: "c1", content: "hi", source: { filename: "a.pdf" } }],
    }),
  )
  const response = await client.search("q")
  expect(response.results[0]?.chunkId).toBe("c1")
  expect(response.results[0]?.source.filename).toBe("a.pdf")
})

test("resolves tag names through the tags endpoint", async () => {
  const paths: string[] = []
  const client = makeClient(async (request) => {
    paths.push(new URL(request.url).pathname)
    if (request.method === "GET") {
      return json({
        results: [
          { id: 1, name: "legal" },
          { id: 2, name: "hr" },
        ],
      })
    }
    const body = (await request.json()) as Record<string, unknown>
    // Ids keep their order, resolved names are appended, matching the Python SDK.
    expect(body.tag_id).toEqual([5, 1])
    return json(EMPTY)
  })
  await client.search("q", { tags: ["legal", 5] })
  expect(paths).toEqual(["/api/v3/tags", "/api/v3/search"])
})

test("an unknown tag name throws rather than widening the query", async () => {
  const client = makeClient(() => json({ results: [{ id: 1, name: "legal" }] }))
  await expect(client.search("q", { tags: ["nope"] })).rejects.toThrow(
    /unknown tag name\(s\): nope/,
  )
})

test("does not list tags when no name needs resolving", async () => {
  const paths: string[] = []
  const client = makeClient((request) => {
    paths.push(new URL(request.url).pathname)
    return json(EMPTY)
  })
  await client.search("q", { tags: [1, 2] })
  expect(paths).toEqual(["/api/v3/search"])
})

// --- scope ------------------------------------------------------------------

/** Every request as `[path, body]`, answering the scope endpoint with `scope`. */
function recording(scope: unknown = SCOPE) {
  const seen: [string, unknown][] = []
  const client = makeClient(async (request) => {
    const path = new URL(request.url).pathname
    seen.push([path, await request.json()])
    return json(path.endsWith("/scope") ? scope : EMPTY)
  })
  return { client, seen }
}

test("scope: true resolves a scope, then narrows the search by it", async () => {
  const { client, seen } = recording()
  await client.search("battery cooling", { scope: true })
  expect(
    seen.map(([path]) => path),
    "the scope must be resolved before the search it narrows",
  ).toEqual(["/api/v3/content-types/scope", "/api/v3/search"])
  // Resolved from the search's own query, with no model, so no LLM call.
  expect(seen[0]?.[1]).toEqual({ query: "battery cooling" })
  expect(seen[1]?.[1]).toEqual({
    query: "battery cooling",
    content_type: ["patent:electricity"],
  })
})

test("a resolved scope is applied as-is, with no extra request", async () => {
  const { client, seen } = recording()
  await client.search("battery cooling", { scope: RESOLVED_SCOPE })
  expect(seen, "an already-resolved scope must not be resolved again").toHaveLength(1)
  expect(seen[0]?.[1]).toEqual({
    query: "battery cooling",
    content_type: ["patent:electricity"],
    attribute: ["filing_date:>=2023-01-01"],
  })
})

test("a scope without a signal narrows nothing", async () => {
  const { client, seen } = recording({ ...SCOPE, has_signal: false })
  await client.search("q", { scope: true })
  expect(seen[1]?.[1], "same body as a plain search").toEqual({ query: "q" })
})

test("scope refuses to combine with explicit facet filters", async () => {
  const { client, seen } = recording()
  await expect(
    client.search("q", { scope: true, contentType: ["legal"] }),
  ).rejects.toThrow(/not both/)
  await expect(
    client.search("q", { scope: RESOLVED_SCOPE, attribute: ["status:active"] }),
  ).rejects.toThrow(/not both/)
  expect(seen).toHaveLength(0)
})
