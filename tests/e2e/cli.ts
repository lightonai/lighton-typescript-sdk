/**
 * End-to-end smoke test against the **live** LightOn API.
 *
 * Not part of the vitest suite (which is offline): this hits the real API with
 * `LIGHTON_API_KEY`, creates a throwaway workspace `e2e-<stamp>`, ingests the documents
 * in `tests/e2e/documents/`, exercises every SDK feature against them, then deletes
 * everything it created.
 *
 *     make e2e
 *     make e2e ARGS="--only search --only ask"
 *     make e2e ARGS="--skip batch --keep"
 *     make e2e ARGS="--list-steps"
 *
 * Steps run in order and share one workspace. A failing step is reported and the run
 * continues, so one broken feature does not hide the rest. Exit code is 1 if any step
 * failed.
 */

import assert from "node:assert/strict"
import { readdir, readFile, stat } from "node:fs/promises"
import { basename, extname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs, styleText } from "node:util"
import { z } from "zod"
import {
  ApiKey,
  type ApiKeyScope,
  type Attribute,
  AttributeType,
  ContentType,
  DownloadPurpose,
  ExecMode,
  File,
  LightOn,
  NotFoundError,
  RelevanceScoring,
  Role,
  SearchMode,
  Tag,
  ThumbnailStatus,
  Workspace,
  waitAll,
} from "../../src/index.ts"
import { DocumentOutline, DocumentSummary, GroundedAnswer } from "./schemas.ts"

const DOCS_DIR = new URL("documents/", import.meta.url).pathname
const JOB_TIMEOUT_MS = 300_000
/** Implied by --only: every other step builds on these two. */
const PREREQS = ["workspace", "upload"] as const

interface Doc {
  path: string
  name: string
  stem: string
  size: number
}

interface Ctx {
  client: LightOn
  docs: Doc[]
  stamp: string
  askQuery?: string
  searchQuery?: string
  ws?: Workspace & { id: number }
  file?: File & { id: number }
  tag?: Tag & { id: number }
  /** The file stays classified as this. */
  contentType?: ContentType
  /** A leaf the file is NOT classified as. */
  otherContentType?: ContentType
  /** An `attribute` entry that should match. */
  attributeFilter?: string
  /** Derived once by topic(), cached here. */
  topic?: string
  cleanup: (() => Promise<unknown>)[]
}

/** The shared workspace, or a clear error when the `workspace` step was skipped. */
function workspaceOf(c: Ctx): Workspace & { id: number } {
  if (!c.ws) throw new Error("this step needs the `workspace` step (don't skip it)")
  return c.ws
}

/** The ingested file, or a clear error when the `upload` step was skipped. */
function uploadedOf(c: Ctx): File & { id: number } {
  if (!c.file) throw new Error("this step needs the `upload` step (don't skip it)")
  return c.file
}

type Step = (c: Ctx) => Promise<void>

/** Registered in definition order, which is also run order. */
const STEPS = new Map<string, { run: Step; summary: string }>()

function step(name: string, summary: string, run: Step): void {
  STEPS.set(name, { run, summary })
}

function say(message: string, colour: Parameters<typeof styleText>[0] = "white"): void {
  console.log(styleText(colour, `    ${message}`))
}

/**
 * A phrase lifted from the first document, cached for the run.
 *
 * The run cannot know what your corpus is about, and a query with no semantic overlap
 * legitimately returns zero chunks, which would read as a broken search. Querying text
 * the document actually contains keeps search and ask about the SDK's plumbing, not
 * about retrieval quality. Override with --search-query.
 */
async function topicOf(c: Ctx): Promise<string> {
  if (c.topic === undefined) {
    const first = c.docs[0] as Doc
    const parsed = await c.client.parse({ file: first.path })
    const page = parsed.result.pages[0]?.markdown ?? ""
    const lines = page.split("\n").map((line) => line.replace(/[*#|>_`-]/g, " ").trim())
    const longest = lines.reduce(
      (best, line) =>
        line.split(/\s+/).length > best.split(/\s+/).length ? line : best,
      "",
    )
    c.topic = longest.split(/\s+/).slice(0, 12).join(" ") || first.stem
    say(`derived query from ${first.name}: ${JSON.stringify(c.topic)}`)
  }
  return c.topic
}

// --- steps ------------------------------------------------------------------

step("workspace", "create, list, get, save, refresh", async (c) => {
  const ws = await new Workspace({
    name: `e2e-${c.stamp}`,
    description: "SDK e2e run",
  }).create(c.client)
  c.cleanup.push(() => ws.delete())
  c.ws = ws
  say(`created workspace ${ws.id}`)

  const all = await Workspace.list(c.client)
  assert.ok(
    all.some((w) => w.id === ws.id),
    "missing from list()",
  )
  assert.equal(
    (await Workspace.get(c.client, ws.id)).name,
    ws.name,
    "get() name mismatch",
  )

  const listed = all.find((w) => w.id === ws.id) as Workspace
  assert.ok(listed.userRole, "userRole is a free read off the listing")
  say(`userRole=${listed.userRole}, sync=${listed.sync?.datasourceType ?? null}`)

  ws.description = "renamed by e2e"
  await ws.save()
  await ws.refresh()
  assert.equal(ws.description, "renamed by e2e", "save() did not persist")
  say("list / get / save / refresh ok")
})

step("upload", "ingest (blocking), getByName, save title, list", async (c) => {
  const ws = workspaceOf(c)
  const doc = c.docs[0] as Doc
  const f = await ws.ingest(
    new File({
      path: doc.path,
      externalMetadata: {
        externalId: `e2e-${c.stamp}`,
        docType: "incident",
        additionalMetadata: { run: c.stamp },
      },
    }),
    { wait: true },
  )
  c.file = f
  say(`ingested ${doc.name} as file ${f.id} (${f.status}, ${f.totalPages} pages)`)

  // By the name we uploaded, though the server stored it as f.filename.
  const found = await File.getByName(c.client, doc.name, ws)
  assert.deepEqual(
    found.map((x) => x.id),
    [f.id],
    "getByName() returned the wrong files",
  )

  f.title = `e2e ${doc.stem}`
  await f.save()
  await f.refresh()
  assert.equal(f.title, `e2e ${doc.stem}`, "title did not persist")

  // externalMetadata: set on upload, round-trips, and merges on update.
  assert.ok(f.externalMetadata, "externalMetadata did not come back")
  assert.equal(f.externalMetadata.externalId, `e2e-${c.stamp}`, "origin id was lost")
  await f.save({ externalMetadata: { docType: "ticket" } }) // partial: merges
  await f.refresh()
  const got = f.externalMetadata
  assert.ok(got, "externalMetadata vanished")
  assert.equal(got.docType, "ticket", "partial update did not apply")
  assert.equal(got.externalId, `e2e-${c.stamp}`, "a partial update dropped externalId")
  assert.equal(
    (got.additionalMetadata as Record<string, unknown> | undefined)?.run,
    c.stamp,
    "a partial update dropped additionalMetadata",
  )
  say(`external metadata merged: ${got.externalId} / ${got.docType}`)

  // Finding a document by its origin id is what external metadata is for. The miss case
  // is what proves the filter reached the server rather than being dropped on the way.
  const byOrigin = await File.list(c.client, {
    workspaceId: ws.id,
    filters: { external_metadata__external_id: `e2e-${c.stamp}` },
  })
  assert.deepEqual(
    byOrigin.map((x) => x.id),
    [f.id],
    "filter by external id did not find the file",
  )
  const noOrigin = await File.list(c.client, {
    workspaceId: ws.id,
    filters: { external_metadata__external_id: "e2e-no-such-origin" },
  })
  assert.equal(noOrigin.length, 0, "an unmatched external id still returned files")
  say("list filtered by external id: 1 hit, and 0 for an unknown id")

  const listed = await File.list(c.client, { workspaceId: ws.id })
  assert.ok(
    listed.some((x) => x.id === f.id),
    "missing from File.list()",
  )
  say(`getByName / save / list ok (${listed.length} file(s) in workspace)`)
})

step("tags", "create, list, file.tag, file.untag", async (c) => {
  const f = uploadedOf(c)
  const tag = await new Tag({
    name: `e2e-${c.stamp}`,
    description: "SDK e2e run",
  }).create(c.client)
  c.cleanup.push(() => tag.delete())
  c.tag = tag
  say(`created tag ${tag.id}`)

  const all = await Tag.list(c.client)
  assert.ok(
    all.some((t) => t.id === tag.id),
    "missing from list()",
  )
  await f.tag([tag.name]) // by name, which exercises the resolver's lookup path
  say("tagged the file by name")
  await f.untag([tag])
  await f.tag([tag]) // re-tag: the search step filters on it
  say("untag / re-tag ok")
})

/** Every leaf of a taxonomy tree, depth-first. */
function* leaves(nodes: readonly ContentType[]): Generator<ContentType> {
  for (const node of nodes) {
    if (node.children?.length) yield* leaves(node.children)
    else yield node
  }
}

/** A syntactically valid value for an attribute, or undefined if the type is unknown. */
function sampleValue(attr: Attribute): unknown {
  switch (attr.type) {
    case "text":
      return "e2e"
    case "number":
      return 1
    case "boolean":
      return true
    case "date":
      return "2026-01-01"
    case "select":
      return attr.choices?.[0]
    case "multi-select":
      return attr.choices?.[0] === undefined ? undefined : [attr.choices[0]]
    default:
      return undefined
  }
}

/**
 * Build a throwaway tree so an empty tenant still exercises the facet paths.
 *
 * Exercises the taxonomy writes on the way: define a root, a child, a select and a text
 * attribute, then a batch, with an undefine registered for teardown. Undefine cascades,
 * so one per root is enough.
 */
async function seedTaxonomy(c: Ctx): Promise<ContentType[]> {
  // Codes are lowercase alphanumeric and hyphens, enforced server-side.
  const code = `e2e-${c.stamp}`
  for (const suffix of ["", "-other"]) {
    const root = await ContentType.define(
      c.client,
      code + suffix,
      `E2E ${c.stamp}${suffix}`,
      { description: "SDK e2e run" },
    )
    c.cleanup.push(() => ContentType.undefine(c.client, root.path))
  }

  const child = await ContentType.define(c.client, "child", "Child", { parent: code })
  const attr = await ContentType.defineAttribute(
    c.client,
    code,
    "e2e_marker",
    AttributeType.text,
  )
  const select = await ContentType.defineAttribute(
    c.client,
    child,
    "e2e_region",
    AttributeType.select,
    { choices: ["FR", "US"] },
  )
  assert.deepEqual(select.choices, ["FR", "US"], "choices did not stick")

  // A select needs choices: refused client-side, with no round trip.
  await assert.rejects(
    () => ContentType.defineAttribute(c.client, child, "nope", AttributeType.select),
    /needs choices/,
    "a select without choices should have been refused",
  )

  const results = await ContentType.batch(c.client, [
    {
      action: "define_content_type",
      parent_path: code,
      code: "batched",
      label: "Batched",
    },
    {
      action: "define_attribute",
      content_type_path: code,
      name: "e2e_batched",
      attribute_type: "boolean",
    },
  ])
  assert.ok(
    results.every((r) => r.status < 300),
    `batch failed: ${JSON.stringify(results)}`,
  )
  const batched = (results[1]?.data as { name?: string } | undefined)?.name
  say(
    `defined ${code} (+child, +batched), attributes ${attr.name}/${select.name}/${batched}`,
  )
  return ContentType.list(c.client, { includeAttributes: true })
}

step(
  "content_types",
  "list taxonomy, classify, set/clear attribute, facets, unclassify",
  async (c) => {
    const f = uploadedOf(c)
    const catalog = await ContentType.templates(c.client)
    say(
      `${catalog.length} template(s) available to adopt: ${catalog
        .slice(0, 5)
        .map((t) => t.path)
        .join(", ")}`,
    )

    let roots = await ContentType.list(c.client, { includeAttributes: true })
    if (roots.length === 0) roots = await seedTaxonomy(c)
    if (roots.length === 0) {
      say("no content types configured on this tenant, nothing to classify")
      return
    }
    say(`${roots.length} root content type(s): ${roots.map((r) => r.path).join(", ")}`)

    const all = [...leaves(roots)]
    const ct = all[0] as ContentType
    await f.classify(ct)
    assert.ok(
      (await f.facets()).some((x) => x.path === ct.path),
      "classify() did not stick",
    )
    say(`classified as ${ct.path}`)

    const attr = (ct.attributes ?? []).find((a) => sampleValue(a) !== undefined)
    if (!attr) {
      say("that content type defines no attributes, skipping set/clear")
    } else {
      await f.setAttribute(ct, attr.name, sampleValue(attr))
      const values = new Map(
        (await f.facets()).flatMap((facet) =>
          facet.attributes.map((a) => [a.name, a.value]),
        ),
      )
      assert.notEqual(values.get(attr.name), undefined, `${attr.name} was not set`)
      say(`set attribute ${attr.name}=${JSON.stringify(values.get(attr.name))}`)
      await f.clearAttribute(ct, attr.name)
    }

    await f.unclassify(ct)
    assert.ok(
      !(await f.facets()).some((x) => x.path === ct.path),
      "unclassify() did not stick",
    )
    say("unclassify ok")

    // Classification coverage shows up on the workspace listing, not on get().
    await f.classify(ct)
    const listed = (await Workspace.list(c.client)).find(
      (w) => w.id === workspaceOf(c).id,
    ) as Workspace
    const tax = listed.taxonomy
    assert.ok(tax, "taxonomy is null despite a classified file")
    assert.ok(tax.classifiedFilesRate > 0, `rate is ${tax.classifiedFilesRate}`)
    assert.ok(
      tax.rootContentTypes.some((r) => r.path === ct.path.split(":")[0]),
      `${ct.path} missing from ${JSON.stringify(tax.rootContentTypes.map((r) => r.path))}`,
    )
    say(
      `taxonomy: ${Math.round(tax.classifiedFilesRate * 100)}% classified, roots ` +
        JSON.stringify(tax.rootContentTypes.map((r) => [r.path, r.count])),
    )

    const before = JSON.stringify(listed.taxonomy)
    await listed.refresh() // the detail endpoint omits the key, so it must survive
    assert.equal(
      JSON.stringify(listed.taxonomy),
      before,
      "refresh() cleared a field it never receives",
    )
    say("taxonomy survives refresh()")

    // Re-classify (mirrors the tags step's re-tag): facet_filters filters on this.
    await f.classify(ct)
    c.contentType = ct
    const other = all.find((x) => x.path !== ct.path)
    if (other) c.otherContentType = other
    if (attr) {
      const value = sampleValue(attr)
      await f.setAttribute(ct, attr.name, value)
      // `name:value` for a plain string, else the type-agnostic "has any value" form.
      c.attributeFilter =
        typeof value === "string" ? `${attr.name}:${value}` : attr.name
      say(`left attribute filter ${JSON.stringify(c.attributeFilter)} on the file`)
    }
  },
)

step(
  "facet_filters",
  "contentType and attribute filters on search and ask",
  async (c) => {
    const ws = workspaceOf(c)
    const ct = c.contentType
    if (!ct) {
      say("nothing classified, run with --only content_types --only facet_filters")
      return
    }
    const query = c.searchQuery ?? (await topicOf(c))

    // A ContentType node, not just a path: the SDK coerces it via `.path`.
    const hits = (
      await c.client.search(query, {
        workspaces: [ws],
        contentType: [ct],
        maxResults: 5,
      })
    ).results
    assert.ok(
      hits.length > 0,
      `contentType=${ct.path} returned nothing, but the file is classified as it`,
    )
    say(`search contentType=${ct.path} -> ${hits.length} chunk(s)`)

    // A leaf the file is NOT classified as must filter it out, otherwise the filter
    // never reached the server.
    if (c.otherContentType) {
      const other = c.otherContentType.path
      const none = (
        await c.client.search(query, {
          workspaces: [ws],
          contentType: [other],
          maxResults: 5,
        })
      ).results
      assert.equal(none.length, 0, `contentType=${other} still returned chunks`)
      say(`search contentType=${other} -> 0 chunk(s), as expected`)
    }

    if (c.attributeFilter) {
      const got = (
        await c.client.search(query, {
          workspaces: [ws],
          attribute: [c.attributeFilter],
          maxResults: 5,
        })
      ).results
      assert.ok(got.length > 0, `attribute=${c.attributeFilter} returned nothing`)
      say(`search attribute=${c.attributeFilter} -> ${got.length} chunk(s)`)

      const miss = `${c.attributeFilter.split(":")[0]}:e2e-no-such-value`
      const none = (
        await c.client.search(query, {
          workspaces: [ws],
          attribute: [miss],
          maxResults: 5,
        })
      ).results
      assert.equal(none.length, 0, `attribute=${miss} still returned chunks`)
      say(`search attribute=${miss} -> 0 chunk(s), as expected`)
    }

    const answered = await c.client.ask(query, {
      workspaces: [ws],
      contentType: [ct.path],
      ...(c.attributeFilter ? { attribute: [c.attributeFilter] } : {}),
      maxResults: 5,
    })
    assert.ok(answered.results.length > 0, "ask with facet filters grounded on nothing")
    say(`ask with facet filters -> ${answered.results.length} source chunk(s)`)
  },
)

step("search", "workspace-scoped, file-scoped, tag-scoped", async (c) => {
  const ws = workspaceOf(c)
  const f = uploadedOf(c)
  const query = c.searchQuery ?? (await topicOf(c))

  const hits = (
    await c.client.search(query, {
      workspaces: [ws],
      maxResults: 5,
      mode: SearchMode.text,
      relevanceScoring: RelevanceScoring.scoringAndFiltering,
      includeBboxes: true,
    })
  ).results
  assert.ok(hits.length > 0, `workspace-scoped search for ${query} returned nothing`)
  say(`${hits.length} chunk(s) in the workspace, top score ${hits[0]?.score}`)

  const scoped = (await c.client.search(query, { files: [f], maxResults: 3 })).results
  assert.ok(scoped.length > 0, "file-scoped search returned nothing")
  say("file-scoped search ok")

  if (c.tag) {
    const got = (await c.client.search(query, { tags: [c.tag], maxResults: 3 })).results
    say(`tag-scoped search returned ${got.length} chunk(s)`)
  }
})

step("ask", "grounded answer, then structured output via schema", async (c) => {
  const ws = workspaceOf(c)
  const query = c.askQuery ?? `What does the document say about ${await topicOf(c)}?`

  const answered = await c.client.ask(query, {
    workspaces: [ws],
    maxResults: 5,
    relevanceScoring: RelevanceScoring.scoringAndFiltering,
  })
  assert.ok(answered.answer, `ask(${query}) returned an empty answer`)
  say(
    `answer (${answered.results.length} source chunk(s)): ${answered.answer.slice(0, 160)}`,
  )

  // Structured output: the answer comes back as JSON text matching the schema.
  const structured = await c.client.ask(query, {
    workspaces: [ws],
    schema: GroundedAnswer,
  })
  const parsed = GroundedAnswer.parse(JSON.parse(structured.answer)) // throws if off-schema
  say(`structured: confident=${parsed.confident} ${parsed.answer.slice(0, 120)}`)
})

step("stream", "sources, tokens, done, and composed with a schema", async (c) => {
  const ws = workspaceOf(c)
  const query = c.askQuery ?? `What does the document say about ${await topicOf(c)}?`

  let sources: { source: { filename?: string | null } }[] | null = null
  const tokens: string[] = []
  let done = false
  for await (const event of c.client.ask(query, {
    workspaces: [ws],
    maxResults: 5,
    stream: true,
  })) {
    if (event.type === "sources") {
      assert.equal(sources, null, "sources arrived more than once")
      assert.equal(tokens.length, 0, "sources must arrive before any token")
      sources = event.results
    } else if (event.type === "token") {
      tokens.push(event.text)
    } else {
      done = true
    }
  }
  assert.ok(done, "stream ended without a done event")
  assert.ok(tokens.length > 0, "stream produced no tokens")
  const answer = tokens.join("")
  say(
    `${sources?.length ?? 0} source(s), ${tokens.length} token event(s): ${answer.slice(0, 90)}`,
  )

  // The same items non-streaming ask returns, so a UI can show them right away.
  assert.ok(sources && sources.length > 0, "no sources event")
  assert.ok(sources[0]?.source.filename, "a source came back without a filename")

  // stream + structured output compose: the tokens spell out the JSON.
  let text = ""
  for await (const event of c.client.ask(query, {
    workspaces: [ws],
    schema: GroundedAnswer,
    stream: true,
  })) {
    if (event.type === "token") text += event.text
  }
  const parsed = GroundedAnswer.parse(JSON.parse(text)) // throws if off-schema
  say(`streamed structured output: confident=${parsed.confident}`)

  // A generator: nothing is sent until iteration, and closing early is clean.
  const iterator = c.client.ask(query, { workspaces: [ws], stream: true })
  await iterator.next()
  await iterator.return(undefined)
  say("early close released the stream cleanly")
})

step("parse", "sync parse, then an async parse job", async (c) => {
  const doc = c.docs[0] as Doc
  const pages = (await c.client.parse({ file: doc.path })).result.pages
  assert.ok(pages.length > 0, "sync parse returned no pages")
  say(`sync: ${pages.length} page(s), page 1 is ${pages[0]?.markdown.length} chars`)

  const job = await c.client.parse({
    file: doc.path,
    mode: ExecMode.async,
    wait: true,
    timeoutMs: JOB_TIMEOUT_MS,
  })
  assert.ok(job.result?.pages.length, "async parse returned no pages")
  say(`async: job ${job.id} completed in ${job.processingTimeMs}ms`)
})

step(
  "extract",
  "sync, async job, nested schema (zod and raw object), and an ingested file",
  async (c) => {
    const doc = c.docs[0] as Doc
    const sync = await c.client.extract(DocumentSummary, { file: doc.path })
    assert.ok(sync.result?.data, "sync extract returned no data")
    say(`sync: ${JSON.stringify(sync.result.data)}`)

    const job = await c.client.extract(DocumentSummary, {
      file: doc.path,
      mode: ExecMode.async,
      wait: true,
      timeoutMs: JOB_TIMEOUT_MS,
    })
    assert.ok(job.result?.data, "async extract returned no data")
    say(`async: job ${job.id} completed in ${job.processingTimeMs}ms`)

    // A 422 on either call means $ref reached the API: the SDK stopped inlining.
    const nested = await c.client.extract(DocumentOutline, { file: doc.path })
    assert.ok(nested.result?.data, "nested extract returned no data")
    say(`nested (zod schema): ${JSON.stringify(nested.result.data)}`)

    // `reused: "ref"` on purpose: zod inlines by default, so without it this case
    // never hands the SDK a $ref and the inliner goes untested. pydantic always emits
    // $defs, which is what the Python SDK exercises here.
    const raw = z.toJSONSchema(DocumentOutline, {
      target: "draft-2020-12",
      io: "output",
      reused: "ref",
    })
    assert.ok("$defs" in raw, "zod stopped emitting $defs, this case is now moot")
    const asObject = await c.client.extract(raw as Record<string, unknown>, {
      file: doc.path,
    })
    assert.ok(asObject.result?.data, "nested raw-object extract returned no data")
    say(`nested (raw object): ${JSON.stringify(asObject.result.data)}`)

    // ingested: extract from the already-ingested file, with no re-upload.
    const byId = await c.client.extract(DocumentSummary, { ingested: uploadedOf(c) })
    assert.ok(byId.result?.data, "extract by file id returned no data")
    say(`by file id ${uploadedOf(c).id}: ${JSON.stringify(byId.result.data)}`)
  },
)

step(
  "binary",
  "download each purpose, pages() vs parse(), thumbnail gate",
  async (c) => {
    const f = uploadedOf(c)
    const doc = c.docs[0] as Doc

    const original = await f.download()
    const onDisk = await readFile(doc.path)
    assert.equal(
      Buffer.from(original).equals(onDisk),
      true,
      "download() did not return the bytes we sent",
    )
    say(`download original: ${original.length} bytes, byte-identical to the upload`)

    for (const purpose of [DownloadPurpose.renderedPdf, DownloadPurpose.transcript]) {
      const got = await f.download(purpose)
      assert.ok(got.length > 0, `download(${purpose}) returned nothing`)
      say(`download ${purpose}: ${got.length} bytes`)
    }

    const pages = await f.pages()
    assert.ok(pages.length > 0, "pages() returned nothing for an embedded document")
    assert.ok(pages[0]?.markdown, "first page has no markdown")
    const parsed = (await c.client.parse({ file: doc.path })).result.pages
    assert.deepEqual(
      Object.keys(pages[0] as object).sort(),
      Object.keys(parsed[0] as object).sort(),
      "pages() and parse() must share the Page shape",
    )
    assert.equal(
      pages.length,
      parsed.length,
      "pages() and parse() disagree on page count",
    )
    say(`pages(): ${pages.length} page(s), same Page shape and count as parse()`)

    // Thumbnails are generated independently of ingestion, so READY is not a given.
    await f.refresh()
    const status = f.thumbnail?.status ?? null
    if (status === ThumbnailStatus.READY) {
      const image = await f.downloadThumbnail()
      assert.ok(image.length > 0, "thumbnail READY but the fetch returned nothing")
      say(`thumbnail READY: ${image.length} bytes`)
    } else {
      await assert.rejects(
        () => f.downloadThumbnail(),
        NotFoundError,
        `thumbnail is ${status} but the fetch succeeded`,
      )
      say(`thumbnail ${status}: fetch throws NotFoundError, as documented`)
    }
  },
)

/** The file's tag ids, straight off the API payload: File models no `tags` field. */
async function tagIds(c: Ctx, f: File & { id: number }): Promise<number[]> {
  const data = await c.client.request<{ tags?: ({ id: number } | number)[] }>(
    "GET",
    `/api/v3/files/${f.id}`,
  )
  return (data.tags ?? []).map((t) => (typeof t === "number" ? t : t.id)).sort()
}

step(
  "replace",
  "replace content in place: id, tags and classifications survive",
  async (c) => {
    const f = uploadedOf(c)
    const before = { id: f.id, title: f.title, totalPages: f.totalPages, size: f.size }
    const tagsBefore = await tagIds(c, f)
    const facetsBefore = (await f.facets()).map((x) => x.path).sort()

    // A document whose byte size differs, so "the content changed" is checkable.
    const replacement = c.docs.slice(1).find((d) => d.size !== f.size)
    if (!replacement) {
      say("no second document of a different size, nothing to replace with")
      return
    }

    // The PATCH lands a queued reprocess next to the previous run's status: the exact
    // window where a naive wait() would report success for unstarted work.
    await f.replace(replacement.path)
    assert.equal(
      f.pendingReprocess,
      "update",
      `expected a queued reprocess, got ${f.pendingReprocess}`,
    )
    say(
      `queued: pendingReprocess=${f.pendingReprocess} beside stale status=${f.status}`,
    )

    await f.wait()
    assert.equal(
      f.pendingReprocess ?? null,
      null,
      "wait() returned with a reprocess queued",
    )
    await f.refresh()
    say(
      `replaced with ${replacement.name}: ${before.totalPages} pages/${before.size}B -> ` +
        `${f.totalPages} pages/${f.size}B`,
    )
    say(`filename now ${f.filename}, title still ${f.title}`)

    assert.equal(
      f.id,
      before.id,
      "the id changed, that is the whole point of replace()",
    )
    assert.equal(
      f.title,
      before.title,
      "title should survive, it is the user-facing name",
    )
    assert.equal(f.filename, replacement.name, "filename should follow the new file")
    assert.notDeepEqual(
      [f.totalPages, f.size],
      [before.totalPages, before.size],
      "content did not change",
    )
    assert.ok(
      ["embedded", "parsed"].includes(f.status ?? ""),
      `re-ingestion ended ${f.status}`,
    )
    assert.deepEqual(await tagIds(c, f), tagsBefore, "tags did not survive the replace")
    assert.deepEqual(
      (await f.facets()).map((x) => x.path).sort(),
      facetsBefore,
      "classifications did not survive the replace",
    )
    say(
      `survived: tags ${JSON.stringify(tagsBefore)}, facets ${JSON.stringify(facetsBefore)}`,
    )
  },
)

step(
  "batch",
  "ingestMany sync (glob), async job with live progress, waitAll",
  async (c) => {
    const ws = workspaceOf(c)
    const pattern = join(DOCS_DIR, "*") // a glob string, expanded by ingestMany

    const result = await ws.ingestMany([pattern], { ignoreErrors: true })
    say(`sync: ${result.succeeded.length} uploaded, ${result.failed.length} failed`)
    assert.ok(
      result.ok,
      `sync batch failures: ${JSON.stringify(result.failed.map((x) => x.error.message))}`,
    )
    await waitAll(result.succeeded)
    say("waitAll: every upload reached a terminal-ok status")

    const job = await ws.ingestMany([pattern], {
      mode: ExecMode.async,
      wait: true,
      ignoreErrors: true,
    })
    while (!job.done) {
      const p = job.poll()
      say(`async: ${p.uploaded}/${p.total} uploaded, ${p.ingested} ingested`)
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    const out = await job.wait()
    assert.ok(
      out.ok,
      `async batch failures: ${JSON.stringify(out.failed.map((x) => x.error.message))}`,
    )
    say(`async: ${out.succeeded.length} ingested`)

    // Tear the corpus down in one request instead of one DELETE per file.
    const keep = uploadedOf(c).id
    const doomed = (await File.list(c.client, { workspaceId: ws.id })).filter(
      (f) => f.id !== keep,
    )
    await File.deleteMany(c.client, doomed)
    const left = (await File.list(c.client, { workspaceId: ws.id })).map((f) => f.id)
    assert.deepEqual(left, [keep], `bulk delete left ${JSON.stringify(left)} behind`)
    say(`bulk-deleted ${doomed.length} file(s) in one request, ${left.length} left`)
  },
)

step("keys", "create (scoped), list, get, save, delete", async (c) => {
  const ws = workspaceOf(c)
  const scope: ApiKeyScope = { workspaceId: ws.id, role: Role.viewer }
  const key = await new ApiKey({ name: `e2e-${c.stamp}`, scopes: [scope] }).create(
    c.client,
  )
  c.cleanup.push(() => key.delete())
  assert.ok(key.key, "create() did not return the one-time secret")
  assert.ok(
    !JSON.stringify(key).includes(key.key),
    "the secret leaks into JSON.stringify(key)",
  )
  say(`created key ${key.id} (prefix ${key.prefix}, secret returned once)`)

  const all = await ApiKey.list(c.client)
  assert.ok(
    all.some((k) => k.id === key.id),
    "missing from list()",
  )
  assert.ok(!(await ApiKey.get(c.client, key.id)).key, "get() leaked the secret")

  key.name = `e2e-${c.stamp}-renamed`
  await key.save()
  await key.refresh()
  assert.ok(key.name.endsWith("-renamed"), "save() did not persist")
  say("list / get / save ok")
})

// --- runner -----------------------------------------------------------------

/**
 * Which steps to run, in definition order.
 *
 * `--only` pulls in the prerequisites, because every other step needs a workspace with an
 * ingested file in it. `--skip` still wins, so they stay opt-out-able.
 *
 * @param all - Every registered step name, in run order.
 * @param only - Names passed with --only; empty means all of them.
 * @param skip - Names passed with --skip.
 * @returns The step names to run, in order.
 */
export function chooseSteps(
  all: readonly string[],
  only: readonly string[],
  skip: readonly string[],
): string[] {
  const wanted = only.length > 0 ? new Set([...only, ...PREREQS]) : new Set(all)
  return all.filter((name) => wanted.has(name) && !skip.includes(name))
}

/** Delete what the run created. Deleting the workspace takes its files with it. */
async function teardown(c: Ctx, keep: boolean): Promise<void> {
  if (keep) {
    console.log(
      styleText(
        "yellow",
        `\n--keep: workspace ${c.ws?.id ?? "?"} and its resources left behind`,
      ),
    )
    return
  }
  console.log(styleText(["cyan", "bold"], "\n> teardown"))
  for (const undo of [...c.cleanup].reverse()) {
    try {
      await undo()
    } catch (error) {
      // Keep deleting the rest.
      say(`cleanup failed: ${(error as Error).message}`, "yellow")
    }
  }
  say("deleted every resource this run created")
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      only: { type: "string", multiple: true, default: [] },
      skip: { type: "string", multiple: true, default: [] },
      docs: { type: "string", default: DOCS_DIR },
      "ask-query": { type: "string" },
      "search-query": { type: "string" },
      keep: { type: "boolean", default: false },
      "list-steps": { type: "boolean", default: false },
    },
  })

  if (values["list-steps"]) {
    for (const [name, { summary }] of STEPS) {
      console.log(`${name.padEnd(15)} ${summary}`)
    }
    return 0
  }

  const unknown = [...values.only, ...values.skip].filter((n) => !STEPS.has(n))
  if (unknown.length > 0) {
    console.error(styleText("red", `unknown step(s): ${unknown.sort().join(", ")}`))
    return 1
  }
  const chosen = chooseSteps([...STEPS.keys()], values.only, values.skip)

  const docsDir = values.docs
  const entries = await readdir(docsDir).catch(() => [])
  const docs: Doc[] = []
  for (const name of entries.sort()) {
    if (!extname(name) || name === "README.md") continue
    const path = join(docsDir, name)
    const info = await stat(path)
    if (info.isFile()) {
      docs.push({ path, name, stem: basename(name, extname(name)), size: info.size })
    }
  }
  if (docs.length === 0) {
    console.error(
      styleText(
        "red",
        `no documents in ${docsDir}, drop a few files in there first ` +
          `(see ${join(docsDir, "README.md")})`,
      ),
    )
    return 1
  }
  console.log(
    styleText(
      "blue",
      `${docs.length} document(s): ${docs.map((d) => d.name).join(", ")}`,
    ),
  )

  // "20260918-150423". Codes derived from this are validated server-side as lowercase
  // alphanumeric plus hyphens, so the ISO milliseconds must not leak in.
  const stamp = new Date()
    .toISOString()
    .slice(0, 19)
    .replace(/[-:]/g, "")
    .replace("T", "-")

  const client = new LightOn() // reads LIGHTON_API_KEY
  const c: Ctx = {
    client,
    docs,
    stamp,
    ...(values["ask-query"] ? { askQuery: values["ask-query"] } : {}),
    ...(values["search-query"] ? { searchQuery: values["search-query"] } : {}),
    cleanup: [],
  }

  const failures: string[] = []
  try {
    for (const name of chosen) {
      console.log(styleText(["cyan", "bold"], `\n> ${name}`))
      const started = performance.now()
      try {
        await (STEPS.get(name) as { run: Step }).run(c)
        const took = ((performance.now() - started) / 1000).toFixed(1)
        console.log(styleText("green", `  PASS ${name} (${took}s)`))
      } catch (error) {
        failures.push(name)
        say(String((error as Error).stack ?? error), "red")
        console.log(styleText(["red", "bold"], `  FAIL ${name}`))
      }
    }
  } finally {
    await teardown(c, values.keep)
    client.close()
  }

  const passed = chosen.length - failures.length
  console.log(
    styleText(
      [failures.length > 0 ? "red" : "green", "bold"],
      `\n${passed}/${chosen.length} steps passed` +
        (failures.length > 0 ? `, failed: ${failures.join(", ")}` : ""),
    ),
  )
  return failures.length > 0 ? 1 : 0
}

// Only run when executed directly. Without this guard, importing anything from here (a
// unit test for chooseSteps, say) fires a live API run as a side effect of the import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main().catch((error: unknown) => {
    // A missing API key is the common one, and a stack trace buries the fix.
    console.error(styleText("red", `\n${(error as Error).message}`))
    return 1
  })
}
