import { expect, test } from "vitest"
import { ActiveRecord } from "../src/activeRecord.ts"
import { ApiKey } from "../src/apikey.ts"
import { Role } from "../src/enums.ts"
import { json, makeClient } from "./helpers.ts"

test("create returns the one-time plaintext secret", async () => {
  let body: Record<string, unknown> = {}
  const client = makeClient(async (request) => {
    body = (await request.json()) as Record<string, unknown>
    return json({ id: "k1", name: "ci-pipeline", prefix: "lo_abc", key: "sk-secret" })
  })
  const key = await new ApiKey({
    name: "ci-pipeline",
    scopes: [{ workspaceId: 42, role: Role.viewer }],
  }).create(client)

  expect(body).toEqual({
    name: "ci-pipeline",
    expires_at: null,
    scopes: [{ workspace_id: 42, role: "viewer" }],
  })
  expect(key.key).toBe("sk-secret")
  expect(key.prefix).toBe("lo_abc")
})

test("an unscoped key sends null scopes, not an empty list", async () => {
  // Presence of scopes is what marks a key workspace-scoped, so [] would mean something
  // different from "unscoped".
  let body: Record<string, unknown> = {}
  const client = makeClient(async (request) => {
    body = (await request.json()) as Record<string, unknown>
    return json({ id: "k1" })
  })
  await new ApiKey({ name: "global" }).create(client)
  expect(body.scopes).toBeNull()
})

test("the secret survives a refresh, which never resends it", async () => {
  // Only create() returns `key`. absorb() overwrites just the keys a response carried,
  // which is the only reason it is still readable afterwards.
  let call = 0
  const client = makeClient(() => {
    call += 1
    return call === 1
      ? json({ id: "k1", name: "ci", key: "sk-secret" })
      : json({ id: "k1", name: "ci" }) // detail response: no key at all
  })
  const key = await new ApiKey({ name: "ci" }).create(client)
  expect(key.key).toBe("sk-secret")
  await key.refresh()
  expect(key.key, "refresh() wiped a one-time secret it never receives").toBe(
    "sk-secret",
  )
})

test("a key fetched fresh never carries the secret", async () => {
  const client = makeClient(() => json({ id: "k1", name: "ci", prefix: "lo_abc" }))
  const key = await ApiKey.get(client, "k1")
  expect(key.key).toBeUndefined()
})

test("save patches name and scopes", async () => {
  let body: Record<string, unknown> = {}
  const client = makeClient(async (request) => {
    body = (await request.json()) as Record<string, unknown>
    return json({ id: "k1", name: "ci-v2" })
  })
  const key = ActiveRecord.hydrate(ApiKey, client, { id: "k1", name: "ci" })
  key.name = "ci-v2"
  key.scopes = [{ workspaceId: 1, role: Role.editor }]
  await key.save()
  expect(body).toEqual({
    name: "ci-v2",
    scopes: [{ workspace_id: 1, role: "editor" }],
  })
})
