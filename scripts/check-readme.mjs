/**
 * Type-check every TypeScript snippet in the README against the real SDK.
 *
 * A README full of examples that do not compile is the classic SDK failure, and no other
 * gate looks at them. This extracts each ```ts block into one scratch module, wraps each
 * in a function so blocks do not collide, declares the variables the prose introduces,
 * and runs tsc over the result.
 *
 * Blocks importing an agent framework are skipped: those packages are deliberately not
 * dependencies of this SDK, so there is nothing to check them against.
 */

import { execFileSync } from "node:child_process"
import { readFileSync, rmSync, writeFileSync } from "node:fs"

const SNIPPETS = ".readme-snippets.ts"
const TSCONFIG = ".readme-snippets.tsconfig.json"

/** Packages the README shows integrating with, which this SDK does not depend on. */
const FRAMEWORK_IMPORT = /^import .*(langchain|openai\/agents|llamaindex|"ai")/m

/** Values the prose introduces before, or around, the snippets that use them. */
const PREAMBLE = `/* Generated from README.md. Delete freely. */
import {
  ApiKey, AttributeType, ContentType, DownloadPurpose, ExecMode, type ExternalMetadata,
  File, LightOn, type LightOnConfiguration, MaintenanceError, NotFoundError,
  RateLimitError, RelevanceScoring, Role, SearchMode, ServerError, StreamError, Tag,
  ThumbnailStatus, Workspace, asJsonSchema, waitAll,
} from "./src/index.ts"
import { writeFile } from "node:fs/promises"
import { z } from "zod"

declare const client: LightOn
declare const ws: Workspace & { id: number }
declare const doc: File & { id: number }
declare const f: File & { id: number }
declare const llm: never
declare const blob: Blob
declare const Invoice: Record<string, unknown>
declare const Letter: Record<string, unknown>
declare const Revenue: z.ZodType<{ amount: number }>
declare const contracts: Tag & { id: number }
declare const lightonTool: never
declare const lightonSearch: (query: string) => Promise<string>
void [ApiKey, AttributeType, ContentType, DownloadPurpose, ExecMode, File, LightOn,
  MaintenanceError, NotFoundError, RateLimitError, RelevanceScoring, Role, SearchMode,
  ServerError, StreamError, Tag, ThumbnailStatus, Workspace, asJsonSchema, waitAll, z,
  client, ws, doc, f, llm, blob, Invoice, Letter, Revenue, contracts, lightonTool,
  lightonSearch, writeFile]
type _EM = ExternalMetadata
type _LC = LightOnConfiguration
`

const readme = readFileSync("README.md", "utf8")
const blocks = [...readme.matchAll(/^```ts\n([\s\S]*?)^```/gm)].map((m) => m[1])

const parts = [PREAMBLE]
let checked = 0
let skipped = 0
blocks.forEach((block, index) => {
  if (FRAMEWORK_IMPORT.test(block)) {
    skipped += 1
    return
  }
  const body = block
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("import ") && !line.startsWith("const { LightOn } = require"),
    )
    .join("\n")
  if (!body.trim()) return
  checked += 1
  parts.push(
    `\n// --- README block ${index} ---\nexport async function block${index}() {\n${body}\n}\n`,
  )
})

writeFileSync(SNIPPETS, parts.join("\n"))
writeFileSync(
  TSCONFIG,
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2023",
        lib: ["ES2023", "ESNext.Disposable", "DOM"],
        module: "nodenext",
        moduleResolution: "nodenext",
        types: ["node"],
        strict: true,
        allowImportingTsExtensions: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: [SNIPPETS],
    },
    null,
    2,
  ),
)

try {
  execFileSync("pnpm", ["tsc", "-p", TSCONFIG], { stdio: "inherit" })
  console.log(
    `README: ${checked} snippets type-check, ${skipped} skipped (agent frameworks)`,
  )
} finally {
  rmSync(SNIPPETS, { force: true })
  rmSync(TSCONFIG, { force: true })
}
