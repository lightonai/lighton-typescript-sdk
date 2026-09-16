/**
 * The public surface, pinned.
 *
 * Mirrors the Python SDK's `__all__`: a value dropping out of the barrel file is a
 * breaking change, and is otherwise invisible until someone's import fails. This caught
 * `Tag` going missing after a formatter rewrote an export line.
 */

import { expect, test } from "vitest"
import * as sdk from "../src/index.ts"

const RUNTIME_EXPORTS = [
  // client and version
  "LightOn",
  "VERSION",
  "DEFAULT_BASE_URL",
  // resources
  "ActiveRecord",
  "ApiKey",
  "File",
  "LightOnFile",
  "Tag",
  "Workspace",
  "waitAll",
  // jobs
  "Job",
  "ParseJob",
  "ExtractJob",
  // enums
  "AttributeType",
  "DownloadPurpose",
  "ExecMode",
  "FileStatus",
  "JobStatus",
  "RelevanceScoring",
  "ReprocessLevel",
  "Role",
  "SearchMode",
  "ThumbnailStatus",
  // errors
  "LightOnError",
  "LightOnConnectionError",
  "MalformedResponseError",
  "StreamError",
  "LightOnAPIError",
  "AuthenticationError",
  "PermissionDeniedError",
  "NotFoundError",
  "RateLimitError",
  "ServerError",
  "MaintenanceError",
  "fromResponse",
  // schema helpers
  "asJsonSchema",
  "normalizeJsonSchema",
] as const

test("exports exactly the documented runtime surface", () => {
  // Both directions at once: a missing export and an accidental one both fail here,
  // with a readable diff naming the culprit.
  expect(Object.keys(sdk).sort()).toEqual([...RUNTIME_EXPORTS].sort())
})

test("File is aliased, since it shadows the global File", () => {
  expect(sdk.LightOnFile).toBe(sdk.File)
})
