# LightOn TypeScript SDK

[![npm](https://img.shields.io/npm/v/@lighton-ai/sdk)](https://www.npmjs.com/package/@lighton-ai/sdk)
[![Tests](https://github.com/lightonai/lighton-typescript-sdk/actions/workflows/tests.yml/badge.svg)](https://github.com/lightonai/lighton-typescript-sdk/actions/workflows/tests.yml)
[![Node](https://img.shields.io/badge/node-22%20%7C%2024%20%7C%2026-blue)](https://github.com/lightonai/lighton-typescript-sdk)
[![Docs](https://img.shields.io/badge/docs-developers.lighton.ai-blue)](https://developers.lighton.ai)

Seamlessly integrate state-of-the-art RAG directly into your software.

## What is LightOn?

LightOn is a 🇪🇺 European AI lab building industrial-grade retrieval infrastructure: index your
documents, then query them with grounded ask and search actions, and process documents on the fly
with parse and extract for specific, standalone actions.
This SDK wraps the LightOn API. Create an account and get an API key on
[console.lighton.ai](https://console.lighton.ai) 🚀

**Note from the human maintainers:**
> This code-base is implemented with AI assistance to allow our team to keep up with the required
> development celerity, however be assured that all design-patterns, architectural decisions,
> code-reviews and QA cycles are fully human-backed to ensure that this SDK meet our standards of
> quality and that we maintainers keep full knowledge of its inner workings to better serve the
> developer community <3

## Contents

- [Quick start](#quick-start)
- [Runtimes](#runtimes)
- [Ingestion](#ingestion)
- [Primary verbs](#primary-verbs)
- [Workspaces](#workspaces)
- [Files & ingestion](#files--ingestion)
- [Async jobs & polling](#async-jobs--polling)
- [Extract](#extract)
- [Tags](#tags)
- [Content types](#content-types)
- [API keys](#api-keys)
- [Errors](#errors)
- [Client configuration](#client-configuration)
- [Agent frameworks](#agent-frameworks)
- [Contributing](#contributing)

## Quick start

Install:

```bash
pnpm add @lighton-ai/sdk
```

Set your API key in your environment:

```bash
export LIGHTON_API_KEY="..."
```

Get your first result:

```ts
import { LightOn, Workspace } from "@lighton-ai/sdk"

const client = new LightOn() // reads LIGHTON_API_KEY from the environment

// Create a workspace and ingest a folder of PDFs (glob), blocking until searchable
const ws = await new Workspace({ name: "Docs" }).create(client)
await ws.ingestMany(["docs/**/*.pdf"], { wait: true })

// Search: retrieve the most relevant passages, scoped to that workspace
const chunks = await client.search("Q4 revenues", { workspaces: [ws] })
for (const result of chunks.results) {
  console.log(result.score, result.source.filename, result.content)
}

// Single-turn RAG for simple use-cases, using an LLM registered on your account
const answer = await client.ask("What were Q4 revenues?", {
  workspaces: [ws],
  model: "mistral-large-latest",
})
console.log(answer.answer)
```

## Runtimes

The SDK is built on global `fetch` and Web Streams, with **no runtime dependencies**. It runs on
Node 22+, Bun, Deno, Cloudflare Workers, Vercel Edge and in the browser, and ships both ESM and
CommonJS:

```ts
import { LightOn } from "@lighton-ai/sdk"        // ESM
const { LightOn } = require("@lighton-ai/sdk")   // CommonJS
```

Two capabilities need a filesystem, so they are the only Node-family parts: uploading by `path`,
and expanding glob patterns in `ingestMany()`. `node:fs` is imported lazily, and only when a path
is actually passed, so a browser or Worker build never loads it. Everywhere else, hand the SDK a
`Blob`:

```ts
import { File } from "@lighton-ai/sdk"

await ws.ingest(new File({ blob, filename: "report.pdf" }))
```

Unlike the Python SDK, the client holds no connection pool, so there is nothing you have to close.
`close()` exists to abort requests still in flight, and is wired to `Symbol.dispose` if you want it
to happen at the end of a scope:

```ts
import { LightOn } from "@lighton-ai/sdk"

using client = new LightOn() // close() runs when the block exits
```

## Ingestion

Get documents in first: `ask` and `search` only see files ingested into a workspace. Upload one file
with `Workspace.ingest()`, or many at once with `ingestMany()`. Uploading *is* the ingestion; a
`File` carries a processing `status` you can poll.

```ts
import { ExecMode, File, LightOn, Workspace } from "@lighton-ai/sdk"

const client = new LightOn()
const ws = await Workspace.get(client, 42)

// One file, non-blocking (resolves immediately, status "pending")
const f = await ws.ingest(new File({ path: "report.pdf" }))

// Or block until embedded
await ws.ingest(new File({ path: "report.pdf" }), { wait: true })
```

`ingestMany()` takes paths, `File`s, and **glob patterns** (mixed). Every path is validated before
any upload; it resolves to a `BatchIngest` with `succeeded` and `failed`:

```ts
import { File } from "@lighton-ai/sdk"

const batch = await ws.ingestMany(
  ["contracts/*.pdf", "reports/**/*.docx", new File({ path: "extra.pdf" })],
  {
    wait: true,          // wait for each to finish embedding
    ignoreErrors: true,  // collect failures instead of throwing on the first
  },
)
console.log(batch.succeeded.length, "ok,", batch.failed.length, "failed")
for (const failure of batch.failed) {
  console.log(failure.source, "->", failure.error.message)
}
```

The client paces **every** request (uploads and status polls) to stay under a per-minute cap and
applies the 429 cooldown automatically. It defaults to **1000 requests/minute, the API's limit for
most endpoints**, so batches stay within bounds out of the box. Override it if your account differs,
or pass `null` to disable pacing:

```ts
import { LightOn, Workspace } from "@lighton-ai/sdk"

const client = new LightOn(undefined, { maxRequestsPerMinute: 2000 })
await (await Workspace.get(client, 42)).ingestMany(["docs/**/*.pdf"])
```

Run it in the background with `mode: ExecMode.async` and poll the job's progress:

```ts
import { ExecMode } from "@lighton-ai/sdk"

const job = await ws.ingestMany(["docs/**/*.pdf"], {
  wait: true,
  mode: ExecMode.async,
})

while (!job.done) {
  const p = job.poll()
  console.log(`${p.uploaded}/${p.total} uploaded, ${p.ingested} embedded, ${p.failed} failed`)
  await new Promise((resolve) => setTimeout(resolve, 2000))
}

const result = await job.wait() // once finished
```

Concurrency defaults to 8 uploads at a time; raise or lower it with `maxConcurrency`.

More on file management (list, fetch, tags, delete) and polling in
[Files & ingestion](#files--ingestion) and [Async jobs & polling](#async-jobs--polling).

## Primary verbs

Four actions live directly on the client. `ask` and `search` query your **indexed** documents; scope
them with `workspaces`, `tags` or `files` (objects or bare ids), and narrow further with
`contentType` and `attribute` (see [Content types](#content-types)).
`parse` and `extract` process a document **on the fly**, no indexing required; `extract` can also
target a file you already ingested, with `ingested`. Full reference at
[developers.lighton.ai](https://developers.lighton.ai). The per-verb snippets below assume a
`client`.

### `ask`: single-turn RAG

```ts
const response = await client.ask("What were Q4 revenues?", {
  workspaces: [42],
  maxResults: 5,
  model: "mistral-large-latest",
})
console.log(response.answer)
for (const result of response.results) {
  // the chunks used as grounding
  console.log(result.source.filename, result.score)
}
```

Structured output with `schema`, a Zod schema or a plain JSON Schema object. It is sent as the API's
`response_format`, and **the answer comes back as JSON text in `.answer`**; the SDK does not parse it
back for you, so a mismatch surfaces where you can see it:

```ts
import { z } from "zod"

const Revenue = z.object({
  amount: z.number().describe("Revenue figure, in millions."),
  currency: z.string().describe("ISO 4217 code, e.g. 'EUR'."),
  quarter: z.string().nullable().describe("Fiscal quarter, or null."),
})

const response = await client.ask("What were Q4 revenues?", {
  workspaces: [42],
  schema: Revenue,
})
const revenue = Revenue.parse(JSON.parse(response.answer))
console.log(response.results) // sources are still there
```

`zod` is an optional peer dependency. It is imported only when you actually pass a Zod schema, so
callers who hand over a plain JSON Schema object never pay for it.

Stream the answer with `stream: true`, which returns an async iterable of events:

```ts
for await (const event of client.ask("What were Q4 revenues?", {
  workspaces: [42],
  stream: true,
})) {
  switch (event.type) {
    case "sources":
      console.log("grounded in", event.results.length, "chunks") // arrives first
      break
    case "token":
      process.stdout.write(event.text)
      break
    case "done":
      console.log()
      break
  }
}
```

The event contract:

- `event.type` is a literal discriminator, so each `case` narrows to the right shape.
- `SourcesEvent.results` holds **exactly** what non-streaming `ask` returns.
- Nothing is sent until you start iterating, so a bad request throws on the first step, not at the
  call. Iterate it fully or `break`, so the connection is released.
- A mid-stream failure throws `StreamError` rather than arriving as an event. A truncated answer that
  looks finished is the worse failure.
- Unknown event types are skipped, so new server events cannot break your `switch`.

`stream` composes with `schema`: the tokens then spell out the JSON, so concatenate and parse at the
end.

```ts
let text = ""
for await (const event of client.ask("...", { workspaces: [42], schema: Revenue, stream: true })) {
  if (event.type === "token") text += event.text
}
const revenue = Revenue.parse(JSON.parse(text))
```

### `search`: retrieval only, no generation

```ts
import { RelevanceScoring, SearchMode } from "@lighton-ai/sdk"

const response = await client.search("termination clause", {
  tags: [7],
  mode: SearchMode.text, // .text (hybrid keyword + vector) or .vision (page image)
  includeImage: true,    // base64 page image per chunk
})
for (const result of response.results) {
  console.log(result.score, result.content)
}
```

Facet filtering, which applies to `ask` too:

```ts
const response = await client.search("termination clause", {
  contentType: ["legal:contract"],
  attribute: ["fiscal_year:2024|2025", "status:active"],
})
```

The filter grammar:

- `contentType` is OR-matched and **exact-or-subtree**, so `legal` also matches `legal:contract`.
  Wildcards work: `legal:contract*`, `*nda*`.
- `attribute` entries are ANDed, and `|` ORs within one entry. The forms are `name` (has any value),
  `name:value`, `name:>value`, `name:prefix*` and `name:*text*`.

These are a filter grammar, not field names, so the SDK passes them through exactly as written.

`relevanceScoring` controls the cross-encoder step:

- `scoringAndFiltering` (the default) scores, then drops chunks below the quality threshold.
- `scoringOnly` scores every candidate and returns them all.
- `none` skips scoring for the lowest latency, and `result.scores.relevance` is then null.

### `parse`: document to Markdown

Pass exactly one of `file` or `url`.

```ts
const doc = await client.parse({ file: "report.pdf" })
// const doc = await client.parse({ url: "https://example.com/report.pdf" })

for (const page of doc.result.pages) {
  console.log(page.index, page.markdown)
}
```

### `extract`: schema-guided structured data

Pass exactly one of `file`, `url` or `ingested`.

```ts
const fromDisk = await client.extract(Invoice, { file: "invoice.pdf" })
// or, on a file already in your index, with no re-upload:
const fromIndex = await client.extract(Invoice, { ingested: f })
console.log(fromIndex.result?.data) // one object per page
```

See [Extract](#extract) for the schema rules and the async mode.

## Workspaces

```ts
import { LightOn, Workspace } from "@lighton-ai/sdk"

const client = new LightOn()

const ws = await new Workspace({ name: "Legal", description: "Contracts & NDAs" }).create(client)

ws.name = "Legal EU"
await ws.save()      // persist local edits
await ws.refresh()   // re-fetch

for (const w of await Workspace.list(client)) {
  console.log(w.id, w.name)
}

const fetched = await Workspace.get(client, ws.id)
await ws.delete()
```

`list()` follows pagination to the end, so there is no silent truncation.

### What a listing tells you

Some read-only extras are available **only from `list()`**:

```ts
import { Workspace } from "@lighton-ai/sdk"

for (const w of await Workspace.list(client)) {
  console.log(w.name, w.filesCount, w.userRole) // owner / editor / viewer, or null

  if (w.taxonomy) {
    console.log(`  ${Math.round(w.taxonomy.classifiedFilesRate * 100)}% classified`)
    for (const root of w.taxonomy.rootContentTypes) {
      console.log("  ", root.label, root.count)
    }
  }
  if (w.sync) {
    console.log("  synced from", w.sync.datasourceType, w.sync.lastStatus)
  }
}
```

Two things worth knowing:

- `userRole` arrives as `""` when you hold no role on the workspace. The SDK reads that as `null`
  rather than widening the type to include a meaningless empty string.
- **Only `list()` returns `taxonomy`.** The detail endpoint omits the key entirely, so `get()` and
  `refresh()` neither populate it nor clear an already-loaded value. Re-list for fresh coverage
  numbers.

## Files & ingestion

```ts
import { File, LightOn, waitAll, Workspace } from "@lighton-ai/sdk"

const f = await ws.ingest(new File({ path: "report.pdf" }))
await f.refresh()
console.log(f.status) // pending, parsing, embedding, embedded

// Wait on several at once
const files = await Promise.all(
  ["a.pdf", "b.pdf", "c.pdf"].map((path) => ws.ingest(new File({ path }))),
)
await waitAll(files)

for (const doc of await File.list(client, { workspaceId: 42 })) {
  console.log(doc.id, doc.filename, doc.status)
}

const doc = await File.get(client, f.id)
const matches = await File.getByName(client, "report.pdf", 42) // returns a list

doc.title = "Q4 Report"
await doc.save()

for (const page of await doc.pages()) {
  console.log(page.index, page.markdown)
}

await doc.tag([7, "contracts"])
await doc.untag([12])
await doc.delete()

await File.deleteMany(client, await File.list(client, { workspaceId: 42 }))
```

`getByName` matches the **title**, not the filename: the server uniquifies stored filenames on upload
(`report.pdf` becomes something like `report_20260728_c9be.pdf`), while the title defaults to the
filename minus its extension. So pass the name you uploaded, with or without the extension. Titles
are not unique, so it returns every match; check the length if you need exactly one.

`deleteMany` is all-or-nothing: one unknown id and the API rejects the whole call with 404 and
deletes **nothing**, which surfaces as `NotFoundError`. There is no partial-success report because
there is no partial success. An empty list is a local no-op.

### Listing and filtering

`workspaceId` and `title` cover the common case. Any other filter the endpoint accepts goes under
`filters`, by its API name, and is typed from the API schema, so a misspelled status is a compile
error rather than an empty result:

```ts
import { File } from "@lighton-ai/sdk"

// Find the document a third-party record was ingested from
const [origin] = await File.list(client, {
  workspaceId: 42,
  filters: { external_metadata__external_id: "JIRA-123" },
})

// Newest embedded files carrying tag 7
const recent = await File.list(client, {
  workspaceId: 42,
  filters: { status: "embedded", tag_id: "7", ordering: "-created_at" },
})
```

The names are the API's own (`tag_id`, not `tagId`): like `attribute` strings on search, they are
the server's query grammar, passed through untouched. `Workspace.list`, `Tag.list` and
`ApiKey.list` take `filters` the same way, e.g. `{ filters: { name: "Legal" } }` or
`{ filters: { is_expired: false } }`. There is no `page` filter, because `list()` follows every page
itself; `page_size` is accepted and only changes how many round trips a listing takes.

### Getting the bytes back

```ts
import { writeFile } from "node:fs/promises"
import { DownloadPurpose, ThumbnailStatus } from "@lighton-ai/sdk"

await writeFile("report.pdf", await doc.download())                              // as uploaded
await writeFile("render.pdf", await doc.download(DownloadPurpose.renderedPdf))

await doc.refresh()
if (doc.thumbnail?.status === ThumbnailStatus.READY) {
  await writeFile("thumb.webp", await doc.downloadThumbnail())
}
```

`purpose` is one of `original`, `renderedPdf` or `transcript`. The server falls back to `original`
when a rendition is missing, so it will not 404 for that reason.

Thumbnails are 256x256 WebP, generated asynchronously and **independently of ingestion**, so an
embedded file may still have none. Fetching one that is not `READY` throws `NotFoundError`.

`pages()` is a method, not a field: the text can be large, and it should not ride along on every
`refresh()`. It returns the same `Page` shape `parse` returns, so code moves between parsing a local
file and reading an ingested one without reshaping anything.

### External metadata

```ts
import { ExternalMetadata, File } from "@lighton-ai/sdk"

const doc = await ws.ingest(
  new File({
    path: "incident.pdf",
    externalMetadata: {
      externalId: "JIRA-123",
      docType: "incident",
      additionalMetadata: { url: "https://jira/INC-123", version: 3 },
    },
  }),
)
console.log(doc.externalMetadata?.externalId) // round-trips, including after refresh()

await doc.save({ externalMetadata: { docType: "ticket" } }) // MERGES
```

**Every update merges, all the way into `additionalMetadata`. There is no replace mode.** What you
can remove:

| to remove | how |
| --- | --- |
| `docType` | `{ docType: "" }` |
| one key of `additionalMetadata` | `{ additionalMetadata: { version: null } }` |
| `externalId` | not possible, it can only be overwritten |
| the whole record | not possible |

`save()` absorbs the response, so `doc.externalMetadata` always shows what the server actually kept,
not the partial value you sent.

### What `save()` writes

A plain field is for a plain set. Anything whose server semantics are not a set is an **option**, so
the call site names the operation:

```ts
doc.title = "Q4 Report"
await doc.save()                                  // writes only the title
await doc.save({ tags: ["contracts", 7] })        // REPLACES every tag
await doc.save({ tags: [] })                      // removes them all
await doc.save({ externalMetadata: { docType: "ticket" } }) // MERGES
```

`tags` replaces every tag, auto-assigned ones included; `tag()` and `untag()` stay the additive path.
`filename` is immutable server-side and is never sent.

### Replacing a document's content

```ts
await doc.replace("report_v2.pdf", { wait: true }) // same id, new content
```

The document keeps its id, title, tags and content-type classifications, and is re-ingested from the
new content, so every reference to the id survives what used to need a delete plus a re-upload. The
new file may be of a different type.

There is one trap worth knowing:

```ts
await doc.replace("report_v2.pdf")
console.log(doc.pendingReprocess, doc.status) // "update" "embedded"  <- embedded is STALE
await doc.wait()                              // blocks while a reprocess is queued
console.log(doc.pendingReprocess, doc.status) // null "embedded"      <- the new run
```

The PATCH response describes the **previous** content until reprocessing actually starts, so `wait()`
treats a non-null `pendingReprocess` as not-terminal.

Replace is addressed by **id**, never by name, because titles and filenames are not unique:

```ts
import { File } from "@lighton-ai/sdk"

const docs = await File.getByName(client, "report.pdf", 42)
if (docs.length !== 1) throw new Error(`${docs.length} documents named report.pdf, pick one by id`)
await docs[0].replace("report_v2.pdf", { wait: true })
```

## Async jobs & polling

Two things are asynchronous: **ingestion** (a `File`'s status, polled with `refresh()` or `wait()`),
and **`parse`/`extract` in async mode**, which return a job handle.

```ts
import { ExecMode } from "@lighton-ai/sdk"

const job = await client.extract(Letter, { file: "big-scan.pdf", mode: ExecMode.async })

while (!(await job.poll()).succeeded) {
  if (job.done) throw new Error(`extract job ${job.id} ended as ${job.status}`)
  if (job.progress) {
    console.log(`${job.progress.percentage}% (${job.progress.pagesProcessed} pages)`)
  }
  await new Promise((resolve) => setTimeout(resolve, 2000))
}
for (const row of job.result?.data ?? []) console.log(row)
```

A job handle carries:

- `poll()` re-fetches and **updates the job in place**, returning itself, so
  `while (!(await job.poll()).succeeded)` reads naturally. Pass `{ page }` to page through extract
  results; parse ignores it.
- `done` is terminal, successfully or not. It keys on `completedAt`, not a status string, because the
  API documents only `pending` and `completed` and publishes no failure vocabulary.
- `succeeded` is the one success state.
- `status`, `id`, `progress` and `result`, plus `error` on a `ParseJob`.
- `wait({ timeoutMs, pollMs })` blocks and returns itself, throwing past the deadline or if the job
  did not succeed.

Parse reports failure through its own `error` block:

```ts
import { ExecMode } from "@lighton-ai/sdk"

const job = await client.parse({ file: "big.pdf", mode: ExecMode.async })
while (!(await job.poll()).succeeded) {
  if (job.error) throw new Error(`parse job ${job.id} failed: ${job.error.message}`)
  await new Promise((resolve) => setTimeout(resolve, 2000))
}
for (const page of job.result?.pages ?? []) console.log(page.markdown)
```

Or skip the loop entirely:

```ts
import { ExecMode } from "@lighton-ai/sdk"

const job = await client.extract(Letter, {
  file: "big-scan.pdf",
  mode: ExecMode.async,
  wait: true,
})
const parsed = await (await client.parse({ file: "big.pdf", mode: ExecMode.async })).wait({
  timeoutMs: 1_800_000,
  pollMs: 5000,
})
```

`wait: true` without `mode: ExecMode.async` throws, and is a type error too: it is declared only on
the async overload. It still resolves to the *job*, not the inline response model.

## Extract

`extract` takes a Zod schema or a plain JSON Schema object. Give every field a meaningful
description: the model reads them as **instructions**, not documentation.

```ts
import { z } from "zod"

const Person = z.object({
  lastName: z.string().describe("Family name, as written in the document."),
  firstName: z.string().nullable().describe("Given name; null if not stated."),
  role: z.string().nullable().describe("Title or role if given, e.g. 'sender', 'recipient'."),
})

const Letter = z.object({
  people: z.array(Person).describe("Every person or entity named in the letter."),
  subject: z.string().nullable().describe("The letter's stated subject line, or null if absent."),
})

const response = await client.extract(Letter, { file: "letter.pdf" })
for (const row of response.result?.data ?? []) console.log(row)
```

A plain object works just as well, and needs no `zod`:

```ts
const response = await client.extract(
  {
    type: "object",
    properties: { total: { type: "number" }, currency: { type: ["string", "null"] } },
    required: ["total"],
  },
  { url: "https://example.com/invoice.pdf" },
)
```

Whichever you pass, the schema is normalized before it is sent, because the endpoint rejects `$ref`:

1. `$defs` and `$ref` are **inlined**, which nested schemas need. A `#/$defs/` ref with no target
   throws before the request goes out.
2. A nullable `anyOf` is collapsed to `type: [X, "null"]`.
3. The draft-2020-12 `$schema` marker is added, keeping an existing one.

You can run it yourself:

```ts
import { asJsonSchema } from "@lighton-ai/sdk"

const schema = await asJsonSchema(Letter)
```

**Extracted rows keep your own key names.** `result.data` is shaped by the schema you wrote, so a
`last_name` property stays `last_name` even though the rest of the response is camelCase.

## Tags

```ts
import { LightOn, Tag } from "@lighton-ai/sdk"

const contracts = await new Tag({ name: "contracts", description: "Signed contracts" }).create(client)

for (const tag of await Tag.list(client)) {
  console.log(tag.id, tag.name, tag.documentCount)
}

await contracts.delete()
```

The tags API is **list, create and delete only**. There is no single-tag GET, so `Tag.get()` and
`tag.refresh()` throw a clear message instead of 404ing at runtime.

Assignment accepts `Tag` objects, bare ids, **or names**, mixed freely. Names are resolved through a
single `Tag.list()`, and an unknown name throws rather than silently tagging nothing:

```ts
await doc.tag([contracts])               // Tag object
await doc.tag([12, 13])                  // bare ids
await doc.tag(["contracts", "urgent"])   // names, resolved and existence-checked
await doc.tag([contracts, 12, "urgent"]) // mixed
await doc.untag(["urgent"])
```

Tags scope queries, OR-matched, so a document matches if it carries any of them:

```ts
const answer = await client.ask("What are the termination terms?", { tags: [contracts] })
const hits = await client.search("indemnification", { tags: ["contracts", 12] })
```

## Content types

Three concepts, one shape each:

- **`ContentType`** is a node in the company-wide taxonomy tree, e.g. `legal:contract:nda`. What kind
  of document this is.
- **`Attribute`** is a typed field on a content type, e.g. `jurisdiction` (select) or `signedOn`
  (date). What you can record.
- **`Facet`** is one content type assigned to one file, plus that file's attribute values. What this
  document actually is.

The whole lifecycle:

```ts
import { AttributeType, ContentType } from "@lighton-ai/sdk"

// 1. describe the kind of document, once, company-wide
const nda = await ContentType.define(client, "nda", "NDA", { parent: "legal:contract" })
await ContentType.defineAttribute(client, nda, "jurisdiction", AttributeType.select, {
  choices: ["FR", "US", "UK"],
})

// 2. classify a document and record its values
await doc.classify(nda)
await doc.setAttribute(nda, "jurisdiction", "FR")

// 3. retrieve against the narrowed corpus
await client.search("termination clause", {
  contentType: ["legal:contract:nda"],
  attribute: ["jurisdiction:FR"],
})
```

### Browsing the taxonomy

```ts
import { ContentType } from "@lighton-ai/sdk"

for (const ct of await ContentType.list(client, { includeAttributes: true })) {
  console.log(ct.path, ct.label)
  for (const attr of ct.attributes ?? []) {
    console.log("  ", attr.name, attr.type, attr.choices)
  }
}
```

`ContentType.list()` returns a **tree**, not a paginated flat list, so each node carries its
`children`. Narrow it with `path`, `depth` and `query`.

### Classifying a file

All four of these accept a `ContentType` node or a plain path string:

```ts
await doc.classify("legal:contract:nda")
await doc.setAttribute("legal:contract:nda", "jurisdiction", "FR")
await doc.setAttribute("legal:contract:nda", "signed_on", "2026-07-01") // date, "YYYY-MM-DD"

for (const facet of await doc.facets()) {
  console.log(facet.path, Object.fromEntries(facet.attributes.map((a) => [a.name, a.value])))
}

await doc.clearAttribute("legal:contract:nda", "jurisdiction")
await doc.unclassify("legal:contract:nda")
```

### Building the taxonomy

Start from the catalog:

```ts
import { ContentType } from "@lighton-ai/sdk"

for (const template of await ContentType.templates(client)) {
  console.log(template.path, template.label) // legal, healthcare, finance, tech, ...
}
await ContentType.adopt(client, ["legal", "finance"])
```

A template's `attributes` is a **map** from node path to that node's definitions, covering the whole
subtree, where a live node carries its own flat list.

Or define your own. Everything is idempotent, so `define()` doubles as rename:

```ts
import { AttributeType, ContentType } from "@lighton-ai/sdk"

const compliance = await ContentType.define(client, "compliance", "Compliance")
const audit = await ContentType.define(client, "audit-report", "Audit Report", {
  parent: compliance,
})
await ContentType.defineAttribute(client, audit, "fiscal_year", AttributeType.number)
await ContentType.defineAttribute(client, audit, "jurisdiction", AttributeType.select, {
  choices: ["FR", "US", "UK"],
})

await ContentType.undefineAttribute(client, audit, "fiscal_year")
await ContentType.undefine(client, "compliance") // CASCADES the whole subtree
```

A `code` is lowercase alphanumeric with hyphens (`audit-report`), and an attribute `name` is
snake_case. `choices` is required for `select` and `multi-select`, and the SDK throws client-side
rather than spending a round trip on the API's 422.

Several actions in one request:

```ts
import { ContentType } from "@lighton-ai/sdk"

const results = await ContentType.batch(client, [
  { action: "adopt", content_types: ["legal"] },
  {
    action: "define_attribute",
    content_type_path: "legal",
    name: "jurisdiction",
    attribute_type: "select",
    choices: ["FR", "US"],
  },
])
console.log(results.map((r) => r.status)) // [201, 201]
```

Batch entries are wire bodies, so their keys are the server's rather than the SDK's, and each
result's `data` is handed back untouched, because which shape it holds depends on the action.

## API keys

```ts
import { ApiKey, LightOn, Role } from "@lighton-ai/sdk"

const key = await new ApiKey({
  name: "ci-pipeline",
  scopes: [{ workspaceId: 42, role: Role.viewer }], // omit for an unscoped key
}).create(client)

console.log(key.key) // plaintext secret, shown ONCE

for (const k of await ApiKey.list(client)) {
  console.log(k.id, k.name, k.prefix)
}

const fetched = await ApiKey.get(client, key.id)
fetched.name = "ci-pipeline-v2"
await fetched.save()
await fetched.delete()
```

`key` is returned **only by `create()`**. A later `refresh()` does not wipe it, because the SDK only
overwrites fields a response actually carried, but no other call will ever give it back to you.

It is also kept out of logs: `key.key` reads it, but `console.log(key)`, `JSON.stringify(key)` and
`{ ...key }` all leave it out, the way the Python SDK's `SecretStr` does. Logging a key object by
accident is the likeliest way a secret leaks.

## Errors

Everything the SDK throws derives from `LightOnError`:

```
LightOnError
├── LightOnConnectionError    transport failure before any response
├── MalformedResponseError    a 2xx body that was not JSON
├── StreamError               an error event partway through a stream
└── LightOnAPIError           non-2xx; carries statusCode and body
    ├── AuthenticationError   401, bad or missing API key
    ├── PermissionDeniedError 403, valid credentials, not allowed
    ├── NotFoundError         404
    ├── RateLimitError        429; carries retryAfter in seconds, or null
    └── ServerError           5xx
        └── MaintenanceError  503 during a planned maintenance window
```

```ts
import { MaintenanceError, RateLimitError, ServerError } from "@lighton-ai/sdk"

try {
  await client.search("q")
} catch (error) {
  if (error instanceof MaintenanceError) {
    console.log("come back later:", error.reason, error.startedAt)
  } else if (error instanceof ServerError) {
    throw error // a crash, not a planned window
  } else if (error instanceof RateLimitError) {
    console.log("retry after", error.retryAfter)
  }
}
```

`PermissionDeniedError` is a sibling of `AuthenticationError`, not a subclass, so 401 and 403 are
caught separately. `MaintenanceError` is the one mapping keyed on the **body** rather than the
status: a 503 without the maintenance marker stays a plain `ServerError`, because only one of the two
is worth retrying.

## Client configuration

`apiKey` is a direct argument, deliberately not a config field, so a config object can be shared or
logged without carrying a secret. It falls back to `LIGHTON_API_KEY` in the environment.

```ts
import { LightOn, type LightOnConfiguration } from "@lighton-ai/sdk"

const client = new LightOn("sk-...", {
  baseUrl: "https://lighton.internal.acme.com",
  timeout: 600_000,
  maxRequestsPerMinute: null,
})
```

`baseUrl` is the host only; the SDK appends `/api/v3/...` itself, and a trailing slash is stripped.

| option | default | controls |
| --- | --- | --- |
| `baseUrl` | `https://api.lighton.ai` | API root |
| `timeout` | `120_000` | whole-request deadline, in milliseconds |
| `retries` | `3` | **connection-level** retries with backoff, not HTTP errors |
| `maxRequestsPerMinute` | `1000` | paces every request; `null` disables pacing |
| `rateLimitRetries` | `3` | retries on HTTP 429, honoring `Retry-After` |
| `fetch` | the global one | a custom `fetch`, for a proxy or for tests |

Behavior worth knowing:

- Pacing is a **minimum-interval gate** applied before every request, uploads and polls alike.
- On 429 the SDK waits the `Retry-After` header when the server sends one, else an exponential
  backoff with jitter, and retries.
- **5xx is never retried.** A maintenance window outlasts any cooldown worth waiting.
- A caller's `AbortSignal` is passed through on every verb, and is rethrown untouched rather than
  wrapped, so your cancellation stays yours.

The `fetch` option is the seam the SDK's own tests use, so they never touch the network:

```ts
import { LightOn } from "@lighton-ai/sdk"

const client = new LightOn("test-key", {
  maxRequestsPerMinute: null,
  fetch: async () => Response.json({ results: [], answer: "42" }),
})
```

## Agent frameworks

LightOn drops into any agent framework as a **retrieval tool**: wrap a `client.search()` call that
returns text. In a long-running agent, create the client once for the process lifetime.

```ts
import { LightOn } from "@lighton-ai/sdk"

const client = new LightOn()

/** Search the company's document corpus for passages relevant to the query. */
async function lightonSearch(query: string): Promise<string> {
  const response = await client.search(query, { workspaces: [42], maxResults: 5 })
  return response.results.map((r) => `[${r.source.filename}] ${r.content}`).join("\n\n")
}
```

### Vercel AI SDK

```ts
// pnpm add ai zod
import { tool } from "ai"
import { z } from "zod"

const lightonTool = tool({
  description: "Search the company's document corpus.",
  inputSchema: z.object({ query: z.string() }),
  execute: ({ query }) => lightonSearch(query),
})
// pass to generateText({ tools: { lightonTool }, ... })
```

### LangChain.js

```ts
// pnpm add @langchain/core zod
import { tool } from "@langchain/core/tools"
import { z } from "zod"

const lightonTool = tool(({ query }) => lightonSearch(query), {
  name: "lighton_search",
  description: "Search the company's document corpus.",
  schema: z.object({ query: z.string() }),
})
// bind it: llm.bindTools([lightonTool])
```

### LangGraph.js

```ts
// pnpm add @langchain/langgraph
import { createReactAgent } from "@langchain/langgraph/prebuilt"

const agent = createReactAgent({ llm, tools: [lightonTool] })
await agent.invoke({ messages: [{ role: "user", content: "What are our Q4 revenues?" }] })
```

### OpenAI Agents SDK

```ts
// pnpm add @openai/agents zod
import { Agent, tool } from "@openai/agents"
import { z } from "zod"

const agent = new Agent({
  name: "Search",
  tools: [
    tool({
      name: "lighton_search",
      description: "Search the company's document corpus.",
      parameters: z.object({ query: z.string() }),
      execute: ({ query }) => lightonSearch(query),
    }),
  ],
})
```

### LlamaIndex.TS

```ts
// pnpm add llamaindex zod
import { tool } from "llamaindex"
import { z } from "zod"

const lightonTool = tool({
  name: "lighton_search",
  description: "Search the company's document corpus.",
  parameters: z.object({ query: z.string() }),
  execute: ({ query }) => lightonSearch(query),
})
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Architecture and design decisions live in
[AGENTS.md](AGENTS.md); read it before changing architecture.
