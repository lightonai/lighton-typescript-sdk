/**
 * List filters: every endpoint filter reaches the server under its API name.
 *
 * The Python SDK forwards any keyword to the query string (`list(**params)`); these pin
 * that the TypeScript port does the same, typed from the schema.
 */

import { expect, test } from "vitest"
import { ApiKey } from "../src/apikey.ts"
import { File } from "../src/file.ts"
import { Tag } from "../src/tag.ts"
import { Workspace } from "../src/workspace.ts"
import { json, makeClient } from "./helpers.ts"

/** A client recording each request's query, answering with an empty page. */
function recording(): {
  client: ReturnType<typeof makeClient>
  queries: URLSearchParams[]
} {
  const queries: URLSearchParams[] = []
  const client = makeClient((request) => {
    queries.push(new URL(request.url).searchParams)
    return json({ results: [], next: null })
  })
  return { client, queries }
}

test("File.list forwards any endpoint filter under its API name", async () => {
  const { client, queries } = recording()
  await File.list(client, {
    workspaceId: 42,
    filters: {
      status: "embedded",
      tag_id: "7",
      external_metadata__external_id: "JIRA-123",
      ordering: "-created_at",
    },
  })
  const query = queries[0] as URLSearchParams
  expect(query.get("workspace_id")).toBe("42")
  expect(query.get("status")).toBe("embedded")
  expect(query.get("tag_id")).toBe("7")
  expect(query.get("external_metadata__external_id")).toBe("JIRA-123")
  expect(query.get("ordering")).toBe("-created_at")
})

test("the camelCase options win over the same filter under its API name", async () => {
  const { client, queries } = recording()
  await File.list(client, { workspaceId: 42, filters: { workspace_id: "9" } })
  expect(queries[0]?.getAll("workspace_id")).toEqual(["42"])
})

test("Workspace, Tag and ApiKey lists forward their filters too", async () => {
  const { client, queries } = recording()
  await Workspace.list(client, { filters: { name: "Legal", user_role: "owner" } })
  await Tag.list(client, { filters: { name: "contracts", auto_assign: false } })
  await ApiKey.list(client, { filters: { is_expired: false } })

  expect(Object.fromEntries(queries[0] as URLSearchParams)).toEqual({
    name: "Legal",
    user_role: "owner",
  })
  expect(Object.fromEntries(queries[1] as URLSearchParams)).toEqual({
    name: "contracts",
    auto_assign: "false",
  })
  expect(Object.fromEntries(queries[2] as URLSearchParams)).toEqual({
    is_expired: "false",
  })
})

test("no filters means no query string at all", async () => {
  const { client, queries } = recording()
  await Workspace.list(client)
  await Tag.list(client)
  await ApiKey.list(client)
  expect(queries.map((q) => q.toString())).toEqual(["", "", ""])
})

test("a page filter is dropped, since it would silently skip earlier pages", async () => {
  // The types already refuse `page`; this is the runtime guard for untyped callers.
  const { client, queries } = recording()
  await File.list(client, { filters: { page: 2, page_size: 50 } as never })
  expect(queries[0]?.get("page")).toBeNull()
  expect(queries[0]?.get("page_size"), "page_size only changes round trips").toBe("50")
})

test("filters are sent on the first page only, next links carry them", async () => {
  const seen: string[] = []
  let call = 0
  const client = makeClient((request) => {
    seen.push(request.url)
    call += 1
    return call === 1
      ? json({
          results: [{ id: 1 }],
          next: "https://api.lighton.ai/api/v3/files?page=2&status=embedded",
        })
      : json({ results: [{ id: 2 }], next: null })
  })
  const files = await File.list(client, { filters: { status: "embedded" } })
  expect(files.map((f) => f.id)).toEqual([1, 2])
  expect(seen[1]).toBe("https://api.lighton.ai/api/v3/files?page=2&status=embedded")
})
