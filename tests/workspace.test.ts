import { expect, test } from "vitest"
import { Workspace } from "../src/workspace.ts"
import { json, makeClient } from "./helpers.ts"

/** A tiny stateful fake: PATCH mutates the store, so save()/refresh() are real. */
function store(initial: Record<string, unknown>) {
  const state = { ...initial }
  return {
    state,
    client: makeClient(async (request) => {
      if (request.method === "PATCH") Object.assign(state, await request.json())
      if (request.method === "POST") Object.assign(state, await request.json())
      return json(state)
    }),
  }
}

test("create posts name and description, then absorbs the id", async () => {
  let body: Record<string, unknown> = {}
  const client = makeClient(async (request) => {
    body = (await request.json()) as Record<string, unknown>
    return json({ id: 42, name: "Legal", description: "Contracts", files_count: 0 })
  })
  const ws = await new Workspace({ name: "Legal", description: "Contracts" }).create(
    client,
  )
  expect(body).toEqual({ name: "Legal", description: "Contracts" })
  expect(ws.id).toBe(42)
  expect(ws.filesCount).toBe(0)
})

test("save persists local edits and absorbs the response", async () => {
  const { client } = store({ id: 42, name: "Legal", description: "" })
  const ws = await Workspace.get(client, 42)
  ws.name = "Legal EU"
  await ws.save()
  expect(ws.name).toBe("Legal EU")
})

test("delete clears the local id", async () => {
  const client = makeClient(() => new Response(null, { status: 204 }))
  const ws = Workspace.hydrate(Workspace, client, { id: 42, name: "Legal" })
  await ws.delete()
  expect(ws.id).toBeNull()
})

test("operating on an unpersisted workspace throws at the call site", async () => {
  const ws = new Workspace({ name: "Legal" })
  await expect(ws.save()).rejects.toThrow(/workspace must be created or retrieved/)
})

test("list follows pagination to the end, with no silent truncation", async () => {
  const pages = [
    {
      results: [{ id: 1, name: "a" }],
      next: "https://api.lighton.ai/api/v3/workspaces?page=2",
    },
    { results: [{ id: 2, name: "b" }], next: null },
  ]
  let call = 0
  const client = makeClient(() => json(pages[call++] as unknown))
  const all = await Workspace.list(client)
  expect(all.map((w) => w.id)).toEqual([1, 2])
})

test("camelizes listing-only extras", async () => {
  const client = makeClient(() =>
    json({
      results: [
        {
          id: 1,
          name: "Legal",
          files_count: 12,
          user_role: "owner",
          taxonomy: {
            classified_files_rate: 0.5,
            root_content_types: [{ path: "legal", label: "Legal", count: 6 }],
          },
          sync: { datasource_type: "sharepoint", last_status: "ok" },
        },
      ],
      next: null,
    }),
  )
  const [ws] = await Workspace.list(client)
  expect(ws?.filesCount).toBe(12)
  expect(ws?.userRole).toBe("owner")
  expect(ws?.taxonomy?.classifiedFilesRate).toBe(0.5)
  expect(ws?.taxonomy?.rootContentTypes[0]?.label).toBe("Legal")
  expect(ws?.sync?.datasourceType).toBe("sharepoint")
})

test("a blank user_role reads as null, not as an empty Role", async () => {
  const client = makeClient(() =>
    json({ results: [{ id: 1, name: "a", user_role: "" }] }),
  )
  const [ws] = await Workspace.list(client)
  expect(ws?.userRole).toBeNull()
})

test("refresh does not clear a taxonomy it never receives", async () => {
  // Only list() returns `taxonomy`; the detail endpoint omits the key entirely. This is
  // the whole reason absorb() overwrites only what the response actually carried.
  let call = 0
  const client = makeClient(() => {
    call += 1
    return call === 1
      ? json({
          results: [
            {
              id: 1,
              name: "a",
              taxonomy: { classified_files_rate: 0.5, root_content_types: [] },
            },
          ],
        })
      : json({ id: 1, name: "a" }) // detail response: no taxonomy key at all
  })
  const [ws] = await Workspace.list(client)
  expect(ws?.taxonomy).toBeDefined()
  await ws?.refresh()
  expect(ws?.taxonomy, "refresh() cleared a field it never receives").toBeDefined()
  expect(ws?.taxonomy?.classifiedFilesRate).toBe(0.5)
})

test("ingest uploads into this workspace", async () => {
  const { File } = await import("../src/file.ts")
  let form: FormData = new FormData()
  const client = makeClient(async (request) => {
    if (request.method === "POST" && request.url.endsWith("/files")) {
      form = await request.formData()
      return json({ id: 7, workspace_id: 42, status: "pending" })
    }
    return json({ id: 42, name: "Legal" })
  })
  const ws = await Workspace.get(client, 42)
  const file = await ws.ingest(
    new File({ blob: new Blob(["%PDF"]), filename: "a.pdf" }),
  )
  expect(form.get("workspace_id")).toBe("42")
  expect(file.id).toBe(7)
  expect(file.status).toBe("pending")
})
