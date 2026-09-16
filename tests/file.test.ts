import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeAll, expect, test } from "vitest"
import { ActiveRecord } from "../src/activeRecord.ts"
import { LightOnError, NotFoundError } from "../src/errors.ts"
import { File, waitAll } from "../src/file.ts"
import { json, makeClient } from "./helpers.ts"

let pdfPath: string

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "lighton-"))
  pdfPath = join(dir, "report.pdf")
  await writeFile(pdfPath, "%PDF fake")
})

const bound = (client: ReturnType<typeof makeClient>, data: Record<string, unknown>) =>
  ActiveRecord.hydrate(File, client, data)

// --- create -----------------------------------------------------------------

test("create uploads multipart with the workspace and filename", async () => {
  let form: FormData = new FormData()
  const client = makeClient(async (request) => {
    form = await request.formData()
    return json({ id: 7, workspace_id: 3, filename: "report.pdf", status: "pending" })
  })
  const file = await new File({ path: pdfPath, workspaceId: 3 }).create(client)

  expect(form.get("workspace_id")).toBe("3")
  expect(form.get("filename")).toBe("report.pdf")
  expect(await (form.get("file") as globalThis.File).text()).toBe("%PDF fake")
  expect(file.id).toBe(7)
})

test("create requires a source and a workspace", async () => {
  const client = makeClient(() => json({}))
  await expect(new File({ path: pdfPath }).create(client)).rejects.toThrow(
    /workspaceId is required/,
  )
  await expect(new File({ workspaceId: 3 }).create(client)).rejects.toThrow(
    /File.path or File.blob is required/,
  )
})

test("create sends tags as repeated form fields", async () => {
  let form: FormData = new FormData()
  const client = makeClient(async (request) => {
    form = await request.formData()
    return json({ id: 7 })
  })
  await new File({ path: pdfPath, workspaceId: 3 }).create(client, { tags: [1, 2] })
  expect(form.getAll("tags")).toEqual(["1", "2"])
})

test("create json-encodes external metadata as one form field", async () => {
  let form: FormData = new FormData()
  const client = makeClient(async (request) => {
    form = await request.formData()
    return json({ id: 7 })
  })
  await new File({ path: pdfPath, workspaceId: 3 }).create(client, {
    externalMetadata: {
      externalId: "JIRA-123",
      additionalMetadata: { url: "https://jira/INC-123", version: 3 },
    },
  })
  expect(JSON.parse(form.get("external_metadata") as string)).toEqual({
    external_id: "JIRA-123",
    additional_metadata: { url: "https://jira/INC-123", version: 3 },
  })
})

// --- save: the form-encoding traps ------------------------------------------

test("save omits an unset title instead of blanking it", async () => {
  // A form body encodes an absent value as "", which would wipe the title server-side.
  let body = ""
  const client = makeClient(async (request) => {
    body = await request.text()
    return json({ id: 7 })
  })
  await bound(client, { id: 7 }).save()
  expect(body).toBe("")
})

test("save sends only what it is given", async () => {
  let body = new URLSearchParams()
  const client = makeClient(async (request) => {
    body = new URLSearchParams(await request.text())
    return json({ id: 7, title: "Q4 Report" })
  })
  const file = bound(client, { id: 7, title: "old" })
  file.title = "Q4 Report"
  await file.save()
  expect([...body.keys()]).toEqual(["title"])
  expect(body.get("title")).toBe("Q4 Report")
})

test("save with empty tags sends the clear sentinel", async () => {
  // An empty list vanishes from a form body, and the resulting empty PATCH is rejected.
  let body = new URLSearchParams()
  const client = makeClient(async (request) => {
    body = new URLSearchParams(await request.text())
    return json({ id: 7 })
  })
  await bound(client, { id: 7 }).save({ tags: [] })
  expect(body.getAll("tags")).toEqual(["0"])
})

test("save resolves tag names before sending", async () => {
  let body = new URLSearchParams()
  const client = makeClient(async (request) => {
    if (request.method === "GET") return json({ results: [{ id: 3, name: "legal" }] })
    body = new URLSearchParams(await request.text())
    return json({ id: 7 })
  })
  await bound(client, { id: 7 }).save({ tags: ["legal", 4] })
  expect(body.getAll("tags")).toEqual(["4", "3"])
})

test("external metadata keeps a blank string but drops an unset field", async () => {
  // docType: "" is the documented blank-clear; a null docType is rejected with 422, so
  // an unset field must stay out of the payload entirely.
  let body = new URLSearchParams()
  const client = makeClient(async (request) => {
    body = new URLSearchParams(await request.text())
    return json({ id: 7 })
  })
  await bound(client, { id: 7 }).save({ externalMetadata: { docType: "" } })
  expect(JSON.parse(body.get("external_metadata") as string)).toEqual({ doc_type: "" })
})

test("a null inside additionalMetadata survives, that is how one key is cleared", async () => {
  let body = new URLSearchParams()
  const client = makeClient(async (request) => {
    body = new URLSearchParams(await request.text())
    return json({ id: 7 })
  })
  await bound(client, { id: 7 }).save({
    externalMetadata: { additionalMetadata: { version: null } },
  })
  expect(JSON.parse(body.get("external_metadata") as string)).toEqual({
    additional_metadata: { version: null },
  })
})

test("File has no tags field, the response returns objects but the request takes ids", async () => {
  expect("tags" in new File({})).toBe(false)
})

// --- getByName --------------------------------------------------------------

test("getByName matches the title, narrowing the API's partial match", async () => {
  let query = ""
  const client = makeClient((request) => {
    query = new URL(request.url).search
    return json({
      results: [
        { id: 1, title: "report" },
        { id: 2, title: "report-appendix" }, // partial match, must be filtered out
      ],
    })
  })
  const found = await File.getByName(client, "report.pdf", 3)
  expect(query).toContain("title=report")
  expect(query).toContain("workspace_id=3")
  expect(found.map((f) => f.id)).toEqual([1])
})

test("getByName returns every match, since titles are not unique", async () => {
  const client = makeClient(() =>
    json({
      results: [
        { id: 1, title: "report" },
        { id: 2, title: "report" },
      ],
    }),
  )
  expect(await File.getByName(client, "report", 3)).toHaveLength(2)
})

test("getByName needs a persisted workspace", async () => {
  const client = makeClient(() => json({ results: [] }))
  await expect(File.getByName(client, "a", { id: null })).rejects.toThrow(
    /workspace must be created or retrieved/,
  )
})

// --- deleteMany -------------------------------------------------------------

test("deleteMany posts every id and clears them locally", async () => {
  let body: Record<string, unknown> = {}
  const client = makeClient(async (request) => {
    body = (await request.json()) as Record<string, unknown>
    return new Response(null, { status: 204 })
  })
  const files = [bound(client, { id: 1 }), bound(client, { id: 2 })]
  await File.deleteMany(client, [...files, 9])
  expect(body.ids).toEqual([1, 2, 9])
  expect(files.map((f) => f.id)).toEqual([null, null])
})

test("deleteMany on an empty list is a local no-op", async () => {
  // The endpoint rejects an empty list with 422, so no request is made at all.
  let calls = 0
  const client = makeClient(() => {
    calls += 1
    return json({})
  })
  await File.deleteMany(client, [])
  expect(calls).toBe(0)
})

test("deleteMany is all-or-nothing, a 404 leaves every id in place", async () => {
  const client = makeClient(() =>
    json({ detail: "some of the specified documents not found" }, 404),
  )
  const file = bound(client, { id: 1 })
  await expect(File.deleteMany(client, [file])).rejects.toBeInstanceOf(NotFoundError)
  expect(file.id, "nothing was deleted, so nothing should be cleared").toBe(1)
})

// --- binary content ---------------------------------------------------------

test("download returns raw bytes and passes the purpose", async () => {
  let url = ""
  const client = makeClient((request) => {
    url = request.url
    return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200 })
  })
  const bytes = await bound(client, { id: 7 }).download("rendered_pdf")
  expect(url).toContain("/api/v3/files/7/download?purpose=rendered_pdf")
  expect([...bytes]).toEqual([0x25, 0x50, 0x44, 0x46])
})

test("pages reads stored text back, in the same shape parse returns", async () => {
  let url = ""
  const client = makeClient((request) => {
    url = request.url
    return json({ id: 7, pages: [{ index: 0, markdown: "# Hi" }] })
  })
  const pages = await bound(client, { id: 7 }).pages()
  expect(url).toContain("include_content=true")
  expect(pages).toEqual([{ index: 0, markdown: "# Hi" }])
})

test("pages is empty when the document has no stored text", async () => {
  const client = makeClient(() => json({ id: 7 }))
  expect(await bound(client, { id: 7 }).pages()).toEqual([])
})

// --- tags and facets --------------------------------------------------------

test("tag posts resolved ids, untag deletes one at a time in order", async () => {
  const calls: string[] = []
  const client = makeClient((request) => {
    calls.push(`${request.method} ${new URL(request.url).pathname}`)
    return json({ id: 7 })
  })
  await bound(client, { id: 7 }).tag([1])
  await bound(client, { id: 7 }).untag([1, 2])
  expect(calls).toEqual([
    "POST /api/v3/files/7/tags",
    "DELETE /api/v3/files/7/tags/1",
    "DELETE /api/v3/files/7/tags/2",
  ])
})

test("tagging with an empty list is a no-op", async () => {
  let calls = 0
  const client = makeClient(() => {
    calls += 1
    return json({ id: 7 })
  })
  await bound(client, { id: 7 }).tag([])
  expect(calls).toBe(0)
})

test("classify and setAttribute post facet actions", async () => {
  const bodies: Record<string, unknown>[] = []
  const client = makeClient(async (request) => {
    bodies.push((await request.json()) as Record<string, unknown>)
    return json({})
  })
  const file = bound(client, { id: 7 })
  await file.classify("legal:contract:nda")
  await file.setAttribute({ path: "legal:contract:nda" }, "jurisdiction", "FR")
  await file.clearAttribute("legal:contract:nda", "jurisdiction")
  await file.unclassify("legal:contract:nda")

  expect(bodies).toEqual([
    { action: "classify", content_type_path: "legal:contract:nda" },
    {
      action: "set_value",
      content_type_path: "legal:contract:nda",
      attribute_name: "jurisdiction",
      value: "FR",
    },
    {
      action: "clear_value",
      content_type_path: "legal:contract:nda",
      attribute_name: "jurisdiction",
    },
    { action: "unclassify", content_type_path: "legal:contract:nda" },
  ])
})

test("facets reads the assigned content types", async () => {
  const client = makeClient(() =>
    json({
      content_types: [
        {
          path: "legal",
          label: "Legal",
          attributes: [{ name: "jurisdiction", value: "FR" }],
        },
      ],
    }),
  )
  const facets = await bound(client, { id: 7 }).facets()
  expect(facets[0]?.path).toBe("legal")
  expect(facets[0]?.attributes[0]?.value).toBe("FR")
})

// --- wait: the pendingReprocess trap ----------------------------------------

test("wait returns once the status is terminal-ok", async () => {
  let calls = 0
  const client = makeClient(() => {
    calls += 1
    return json({ id: 7, status: calls === 1 ? "parsing" : "embedded" })
  })
  const file = bound(client, { id: 7, status: "pending" })
  await file.wait({ pollMs: 0 })
  expect(file.status).toBe("embedded")
})

test("wait throws on a terminal failure, carrying the detail", async () => {
  const client = makeClient(() =>
    json({ id: 7, status: "parsing_failed", status_detail: "corrupt pdf" }),
  )
  const file = bound(client, { id: 7, status: "parsing" })
  await expect(file.wait({ pollMs: 0 })).rejects.toThrow(/corrupt pdf/)
  await expect(file.wait({ pollMs: 0 })).rejects.toBeInstanceOf(LightOnError)
})

test("replace keeps the id and reports a queued reprocess", async () => {
  let form: FormData = new FormData()
  const client = makeClient(async (request) => {
    form = await request.formData()
    // The PATCH response describes the PREVIOUS content: a stale "embedded".
    return json({ id: 7, status: "embedded", pending_reprocess: "update" })
  })
  const file = bound(client, { id: 7, status: "embedded" })
  await file.replace({ filename: "v2.pdf", blob: new Blob(["%PDF v2"]) })
  expect((form.get("file") as globalThis.File).name).toBe("v2.pdf")
  expect(file.id).toBe(7)
  expect(file.pendingReprocess).toBe("update")
})

test("wait does not return on the stale status left by a replace", async () => {
  // While pendingReprocess is set, the queued work has not started and `status` still
  // describes the previous run. Trusting it would call a replace() done before it began.
  let calls = 0
  const client = makeClient(async (request) => {
    calls += 1
    if (request.method === "PATCH") {
      return json({ id: 7, status: "embedded", pending_reprocess: "update" })
    }
    // First poll: still queued. Second: the new run has finished.
    return calls <= 2
      ? json({ id: 7, status: "embedded", pending_reprocess: "update" })
      : json({ id: 7, status: "embedded", pending_reprocess: null })
  })
  const file = bound(client, { id: 7, status: "embedded" })
  await file.replace(
    { filename: "v2.pdf", blob: new Blob(["x"]) },
    { wait: true, pollMs: 0 },
  )
  expect(calls, "wait() returned on the stale status").toBeGreaterThan(2)
  expect(file.pendingReprocess).toBeNull()
})

test("wait times out rather than polling forever", async () => {
  const client = makeClient(() => json({ id: 7, status: "parsing" }))
  const file = bound(client, { id: 7, status: "parsing" })
  await expect(file.wait({ pollMs: 0, timeoutMs: 1 })).rejects.toThrow(/after 1ms/)
})

test("waitAll waits for every file", async () => {
  const client = makeClient(() => json({ id: 7, status: "embedded" }))
  const files = [
    bound(client, { id: 1, status: "parsing" }),
    bound(client, { id: 2, status: "parsing" }),
  ]
  const done = await waitAll(files, { pollMs: 0 })
  expect(done.map((f) => f.status)).toEqual(["embedded", "embedded"])
})

test("path survives a refresh, since no response ever carries it", async () => {
  const client = makeClient(() => json({ id: 7, status: "embedded" }))
  const file = new File({ path: pdfPath, workspaceId: 3 })
  await file.create(client)
  await file.refresh()
  expect(file.path, "a local-only field was wiped by absorb()").toBe(pdfPath)
})
