import { expect, test } from "vitest"
import { camelize, toCamel } from "../src/utils.ts"

test("converts snake_case keys", () => {
  expect(toCamel("external_id")).toBe("externalId")
  expect(toCamel("endpoint_category_names")).toBe("endpointCategoryNames")
  expect(toCamel("already")).toBe("already")
  expect(toCamel("total_pages")).toBe("totalPages")
})

test("camelizes nested objects and arrays", () => {
  expect(
    camelize({
      workspace_id: 1,
      results: [{ source: { file_id: 7, page_index: 2 } }],
      thumbnail: { status: "READY" },
    }),
  ).toEqual({
    workspaceId: 1,
    results: [{ source: { fileId: 7, pageIndex: 2 } }],
    thumbnail: { status: "READY" },
  })
})

test("leaves values alone, converting keys only", () => {
  expect(camelize({ attribute: ["fiscal_year:2024|2025"] })).toEqual({
    attribute: ["fiscal_year:2024|2025"],
  })
})

test("passes null and primitives through", () => {
  expect(camelize(null)).toBeNull()
  expect(camelize({ started_at: null, count: 0, ok: false })).toEqual({
    startedAt: null,
    count: 0,
    ok: false,
  })
})

// The three opaque keys. Renaming anything under them would corrupt caller-owned data,
// so each gets its own regression test.

test("leaves extract result rows untouched, they follow the caller's schema", () => {
  const response = {
    processing_time_ms: 12,
    result: { data: [{ last_name: "Curie", first_name: "Marie" }] },
  }
  expect(camelize(response)).toEqual({
    processingTimeMs: 12,
    result: { data: [{ last_name: "Curie", first_name: "Marie" }] },
  })
})

test("leaves additional_metadata keys untouched, they are caller-controlled", () => {
  const response = {
    external_metadata: {
      external_id: "JIRA-123",
      additional_metadata: { build_number: 3, source_url: "https://x" },
    },
  }
  expect(camelize(response)).toEqual({
    externalMetadata: {
      externalId: "JIRA-123",
      additionalMetadata: { build_number: 3, source_url: "https://x" },
    },
  })
})

test("leaves the explain breakdown untouched", () => {
  expect(camelize({ explain: { bm25_score: 1.2 } })).toEqual({
    explain: { bm25_score: 1.2 },
  })
})
