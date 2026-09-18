# Architecture and design decisions

> **Maintenance rule:** whenever a change alters file architecture (moving, adding or removing
> modules) or a design-pattern decision recorded here, update this file in the **same** change. Keep
> it in sync, do not defer it. If a change contradicts a decision below, edit the decision and its
> rationale, do not just append.

This SDK is a port of the [LightOn Python SDK](https://github.com/lightonai/lighton-python-sdk) and
deliberately mirrors its shape, so a team using both re-learns nothing. Where TypeScript makes a
different answer clearly better, the divergence is recorded here with its reason.

## Layout

```
src/
  index.ts          the public surface, one barrel file
  client.ts         LightOn: fetch transport, request()/stream(), rate gate, lifecycle, verb delegates
  activeRecord.ts   the shared resource base, plus listAll()/getOne()
  errors.ts         the error tree and fromResponse()
  enums.ts          controlled vocabularies
  utils.ts          compact, id/ids, path/paths, paginate, camelize
  schema.ts         guided-generation schemas: normalization and Zod detection
  upload.ts         turning a path or Blob into a multipart part
  batch.ts          client-side batch ingestion orchestrator
  job.ts            ParseJob / ExtractJob handles
  workspace.ts file.ts tag.ts apikey.ts contentType.ts
  verbs/            ask.ts search.ts parse.ts extract.ts scope.ts
  types/
    api.ts          GENERATED from the OpenAPI schema, never edited by hand
    index.ts        curated camelCase aliases over api.ts
    config.ts events.ts file.ts workspace.ts batch.ts
tests/              one module per source module, plus e2e/cli.ts
```

`types/` holds pure data shapes only. Anything with behavior (`Workspace`, `BatchIngestJob`) lives at
the top level. A pure-data shape may reference a behavioral one as a field type, as
`types/batch.ts` does with `File`; it stays pure data itself.

## Transport

- **One `request()` chokepoint** does auth, pacing, error mapping and JSON parsing. Every call routes
  through it. Binary endpoints use a keyword `raw: true` flag on that same method rather than a
  sibling helper, because auth, error mapping, the 429 cooldown and the rate gate are exactly what a
  sibling would have duplicated, and errors stay JSON even on a binary endpoint. An empty raw body is
  a zero-length `Uint8Array`, not null.
- **Streaming is the one exception to the flag pattern.** `stream()` cannot be a flag on `request()`
  because the response has to stay open for the caller, which inverts who owns its lifetime.
- **`request()` camelizes every response.** This is the only place it happens, so nothing downstream
  has to think about wire naming. SSE payloads do not pass through it, so `askStream` camelizes them
  explicitly; without that, streaming and non-streaming `ask` would hand back differently-named
  fields.
- **An absolute path is passed through untouched.** A pagination `next` link is a complete URL
  carrying its own query string, and prepending the base to it would silently truncate every
  `list()`.
- **5xx is never retried.** 429 is, honoring `Retry-After` when present, else exponential backoff
  with jitter. Connection failures are retried separately, and neither an `AbortError` nor a
  `TimeoutError` counts as one: retrying a timeout would multiply the caller's deadline by `retries`.
- **A closed client fails immediately.** `close()` can land while an earlier await is pending, so
  `#send` checks the lifetime signal before handing `fetch` a signal that is already aborted.
- **`baseUrl` carries no version**; paths carry the full `/api/v3/...`.
- **The `fetch` option is the test seam**, the way `transport` is in the Python SDK. The unit suite
  is fully offline; a network call in CI is itself a bug.

### Divergences from the Python transport

| Python | Here | Why |
| --- | --- | --- |
| Sync, `httpx.Client` | Async, global `fetch` | There is no sync HTTP in a browser or Worker, and promises are the platform's answer. Everything is async as a result, including `file.tag()` and `ContentType.list()`. |
| Connect 5s / read 120s | One `timeout` | `fetch` cannot express the split. Needs a custom dispatcher to bring back. |
| `threading.Lock` on the rate gate | No lock | Nothing awaits between reading and writing the reservation, so it is already atomic. |
| Transport retries connect errors | Explicit retry loop | `fetch` has no equivalent of `httpx.HTTPTransport(retries=)`. |
| Context manager closes a pool | `close()` only aborts | There is no connection pool to leak, so a `using` block is a convenience rather than a requirement. |

## The camelCase boundary

The SDK presents camelCase over a snake_case wire. This is the one layer with no counterpart in the
Python SDK, and the main thing to get right.

- **Requests are built explicitly with wire keys.** No converter. A generic deep converter is the
  clever option that breaks on caller-controlled keys.
- **Responses go through one `camelize()`** in `request()`, with a matching `Camelize<T>` type applied
  at the curated aliases in `types/index.ts`, so the compiler computes it once per shape rather than
  across the whole generated module.
- **Three keys are opaque**, their values copied through untouched, each with its own regression test:
  - `data`, because extract result rows are shaped by the caller's own JSON Schema, so a `last_name`
    property must stay `last_name`. `ContentType.batch` results ride here too, and the Python SDK
    hands those back un-modelled for the same reason.
  - `additional_metadata`, caller-controlled keys.
  - `explain`, a free-form scoring breakdown.

Adding a fourth opaque key means adding a test that fails without it.

## Resources

- **Active-record over resource-manager**, matching the Python SDK: `File.list(client)`,
  `file.refresh()`, `file.save()`.
- **`absorb()` overwrites only keys the response actually carried.** Load-bearing three times over:
  `Workspace.taxonomy` (only `list()` returns it), `ApiKey.key` (only `create()` returns it) and
  `File.path`/`File.blob` (local only, in no response). A plain `Object.assign` breaks all three
  silently. TypeScript has no runtime view of an interface, so each resource declares a static
  `fields` array; that list is also what stops a response writing arbitrary keys onto a resource.
- **`list()` and `get()` are per-resource statics over the free `listAll()`/`getOne()` helpers**, not
  inherited generics. A generic `static list<T>` on the base cannot be narrowed by a subclass:
  `Promise<File[]>` is not assignable to `Promise<T[]>` and the static side becomes unassignable.
  Free functions are less code and let each resource have an honest signature, which is what
  `Workspace.list()` (no filters), `File.list()` (two) and `Tag.get()` (throws) actually need.
- **`list()` follows pagination to the end.** No silent truncation.
- **Operating on a non-persisted instance throws** via `boundClient()`.
- **Curated shapes are independent of the generated types.** Hand-written models give stable, clean
  developer experience; generated ones are noisy and get regenerated.
- **Only push behavior into the base when a new resource actually shares it.** Do not generalize
  speculatively for a shape only one subclass needs.

### TypeScript-specific hazards, each hit in practice

- **`static bind` shadows `Function.prototype.bind`**, which every class constructor inherits.
  `ParseJob.from` and `ExtractJob.from` are named that way for this reason.
- **`File` shadows the global `File`.** The class keeps the name for parity, but nothing inside the
  SDK relies on the bare global, and `LightOnFile` is exported as an alias for consumers who hit the
  shadowing.
- **`Template` is a sibling interface, not an extension.** It re-types `attributes` from a list to a
  path-keyed map. Python needs a `# type: ignore` for that; TypeScript forbids it outright, so it is
  `extends Omit<ContentType, "attributes">`.
- **`ContentType` is an interface and a const of the same name.** It is not an active record, because
  the endpoint returns a nested tree rather than a paginated list, so there is nothing to bind and no
  per-node lifecycle. Declaration merging gives the Python call sites (`ContentType.list(client)`,
  `node.path`) with no fiction about runtime identity.
- **`Tag.get()` and `tag.refresh()` throw.** The tags API has no single-tag GET, and TypeScript
  cannot remove an inherited member, so they exist to fail with a clear message rather than 404 from
  a URL that was never going to work.
- **Excess-property checking is left alone.** An inline object literal carrying more than `path` is
  rejected where a content type is expected. Widening `PathRef`/`IdRef` with an index signature fixes
  that but then rejects declared types like `File` and `ContentType`, which is the common case. Real
  code passes a variable, which is unaffected.

## Serialization

`JSON.stringify` drops `undefined` but **keeps `null`**, the exact inverse of pydantic's
`model_dump_json(exclude_none=True)`, which drops `None` but keeps `""`. Getting this wrong makes
`save()` send `doc_type: null`, which the API rejects with 422.

`compact()` is therefore load-bearing, not tidiness:

- It drops nullish at the **top level only**, so a null *inside* `additionalMetadata` survives, which
  is how one key gets cleared.
- An empty string still goes through, which is what makes the blank-clear on `docType` work.
- An unset `title` is omitted rather than sent, because a form body encodes an absent value as `""`,
  which would blank the title server-side.
- `tags: []` is sent as the `[0]` sentinel, because an empty list vanishes from a form body and the
  resulting empty PATCH is rejected outright.

## Uploads

Bytes are **buffered, never streamed**: a 429 retry re-sends the same body, and a consumed stream
would re-send nothing. The Python SDK buffers on upload and streams on parse/extract; buffering
everywhere is simpler and strictly safer, and is a deliberate divergence.

`node:fs` and `node:path` are imported **lazily, and only when a path is actually passed**, which is
what keeps the package loadable in a browser or Worker. Globbing uses Node 22's built-in `fs.glob`,
so there is no glob dependency.

## Concurrency

Everything the Python SDK needs threads for collapses:

| Python | Here |
| --- | --- |
| `ThreadPoolExecutor` | a promise pool with a shared cursor |
| `threading.Lock` | nothing; no snapshot can tear when nothing interleaves except at an await |
| `threading.Event` | a promise |
| daemon `Thread` | an un-awaited promise whose error is stashed for `wait()` |
| defensive list copies | `readonly` types, which cost nothing at runtime |

The pool keeps the Python semantics on first error: workers stop *taking* new items, in-flight work
drains, then the error is rethrown.

## Typing

- **Overloads keyed on a literal** so a caller's return type is exact, never a union: `mode` on
  `parse`/`extract`/`ingestMany`, `stream` on `ask`. An illegal combination such as `wait: true`
  without `mode: "async"` is both a type error and a runtime throw.
- **`ask` is not `async`.** It returns either a promise or an async generator, and the generator must
  be returned synchronously to stay lazy.
- **Controlled vocabularies are `as const` objects plus a union type, never `enum`.** The members
  *are* their strings, so `file.status === "embedded"` works and a caller may pass a plain literal. A
  TypeScript `enum` is a nominal type and forbids both. Only vocabularies whose full domain is known
  are modelled; `workspaceType` and `documentUploadMethod` stay plain strings.
- **Responses are typed casts, not validated.** There is no pydantic equivalent worth a runtime
  dependency, and this is what `openai-node` and `stripe-node` do. `openapi-typescript` generates the
  wire types from the same schema the Python SDK generates from.

## Recurring heuristics

1. **Fail loud at the call site.** An unknown tag name throws; a `select` without `choices` throws
   client-side rather than spending a round trip on the API's 422; an SSE error event throws rather
   than yielding a plausible-looking truncated answer.
2. **One chokepoint, flags not siblings**, unless ownership of a lifetime inverts.
3. **Model exactly what the server does, then pin it with a test.** Every quirk here is paired with a
   regression test.
4. **Reuse one shape everywhere.** `file.pages()` returns the same `Page` that `parse` returns;
   `SourcesEvent.results` reuses the same `AskResultItem` as non-streaming `ask`.
5. **Do not model a resource that does not exist.** There is no ingestion-job resource, because the
   File is the job. There is no batch endpoint, because batch is a client-side orchestrator.
6. **Method, not field, when the data is expensive or detail-only**: `pages()`, `facets()`,
   `downloadThumbnail()`.
7. **Document the ceiling instead of engineering around it.** Deliberate simplifications carry a
   `ponytail:` comment naming the ceiling and the upgrade path. `grep -rn "ponytail:" src/` is the
   ledger.

## Conventions

- **Relative imports carry the `.ts` extension**, so `node --experimental-strip-types` and vitest run
  the source tree directly. `tsdown` bundles for the published build, so nothing emits them.
- **All imports at the top of the module.** The exception is a lazy `import()` that exists precisely
  to avoid loading something, which is documented where it appears.
- **Every public function, method and option carries a TSDoc comment** documenting each parameter and
  the return value, plus `@throws` when it throws deliberately. Keep it about behavior and contract,
  not a restatement of the signature. Private helpers and self-evident one-liners are exempt; do not
  pad them.
- **Every field on a hand-written interface carries a doc comment.** The description is the
  documentation: it drives editor hints and generated docs. This does not apply to `types/api.ts`.
- **New dependencies:** prefer the platform, then the standard library, then a few lines, before
  adding anything. The SDK has **zero runtime dependencies** and that is a feature. `zod` is an
  optional peer dependency, loaded only when a caller passes a Zod schema.
- **No em-dashes in documentation.** Not in the README, not here, not in comments. Use a comma, a
  colon, parentheses, or two sentences.
- **Keep the README Contents list in sync.** Adding, removing, renaming or reordering a `##` section
  means updating the list in the same change, matching order and anchor slugs.
- **`src/types/api.ts` is generated.** Never edit it; run `make gen-types`. It is excluded from Biome
  and from the type-checker's own file list.
- **Beware formatter rewrites when editing by text match.** Biome rewrites `export { type X }` into
  `export type { X }` and merges import specifiers, which has twice made a text-anchored edit
  silently match nothing. Edit by region, and let `tests/exports.test.ts` catch a dropped export.

## Testing

- **Unit tests are offline and hermetic.** Every test injects a `fetch` through the client config.
  There is no msw, no nock and no cassettes.
- **A fake `fetch` must honor its signal**, rejecting when aborted and rejecting immediately when
  handed an already-aborted one. A fake that ignores the signal hides real bugs; it hid two.
- **Non-trivial logic leaves at least one runnable test behind**, and every server quirk recorded
  above has a regression test naming what breaks without it.
- **`make test` does not type-check.** Vitest strips types without checking them, so
  `make type-check` and `make test-types` are separate gates and both run in CI.
- **`tests/exports.test.ts` pins the public surface**, in both directions, the way the Python SDK's
  `__all__` does.
- **`tests/e2e/cli.ts` is not collected by vitest.** It runs against the live API with
  `LIGHTON_API_KEY`, creates a throwaway workspace, exercises every verb and resource, and tears down
  after itself. Add a step there when you add a feature.

## Releases

> **Agents: never cut a release unless the user explicitly asks in that message.** `make release`,
> and pushing a `v*` tag, publishes a public npm package and a GitHub Release, and is effectively
> irreversible. Bumping versions, editing release files or planning a release is fine on request;
> *triggering* one requires an explicit, current instruction. Prior approval for other work never
> carries over to this.

Version is single-sourced from `package.json`. `VERSION` is injected at build time by `tsdown`;
never hard-code it.

The supply-chain quarantine (`minimumReleaseAge` in `pnpm-workspace.yaml`) ignores any version
published in the last three days, so a freshly-compromised release is not picked up before it is
vetted. A CI guard fails any PR that changes it. Expect `pnpm install` to resolve slightly older
versions than `latest`; that is the point.
