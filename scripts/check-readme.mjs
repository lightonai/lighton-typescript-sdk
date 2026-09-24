/**
 * Type-check every TypeScript snippet in the README against the real SDK.
 *
 * A README full of examples that do not compile is the classic SDK failure, and no other
 * gate looks at them. Each ```ts block becomes **its own module**, keeping its imports
 * with `@lighton-ai/sdk` pointed at the source tree. So a block that uses a name without
 * importing it fails, a block importing something the SDK does not export fails, and two
 * blocks declaring the same variable do not collide.
 *
 * Variables the prose introduces around the snippets (`client`, `ws`, `doc`...) are
 * declared once in a shared globals file. SDK names are deliberately not in there, so a
 * missing import is still caught.
 *
 * Blocks importing an agent framework are skipped: those packages are deliberately not
 * dependencies of this SDK, so there is nothing to check them against.
 */

import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const DIR = ".readme-snippets"

/** Packages the README shows integrating with, which this SDK does not depend on. */
const FRAMEWORK_IMPORT = /^import .*(langchain|openai\/agents|llamaindex|"ai")/m

/** Values the prose introduces before, or around, the snippets that use them. */
const GLOBALS = `import type { File, LightOn, Tag, Workspace } from "../src/index.ts"
import type { z } from "zod"

declare global {
  const client: LightOn
  const ws: Workspace & { id: number }
  const doc: File & { id: number }
  const f: File & { id: number }
  const contracts: Tag & { id: number }
  const blob: Blob
  const llm: never
  const lightonTool: never
  const lightonSearch: (query: string) => Promise<string>
  const Invoice: Record<string, unknown>
  const Letter: Record<string, unknown>
  const Revenue: z.ZodType<{ amount: number }>
}
`

const readme = readFileSync("README.md", "utf8")
const blocks = [...readme.matchAll(/^```ts\n([\s\S]*?)^```/gm)].map((m) => m[1])

rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR)
writeFileSync(join(DIR, "globals.d.ts"), GLOBALS)

let checked = 0
let skipped = 0
blocks.forEach((block, index) => {
  if (FRAMEWORK_IMPORT.test(block)) {
    skipped += 1
    return
  }
  const body = block
    // The CommonJS spelling sits beside the ESM one to show both; one module can't hold both.
    .split("\n")
    .filter((line) => !line.startsWith("const { LightOn } = require"))
    .join("\n")
    .replaceAll('from "@lighton-ai/sdk"', 'from "../src/index.ts"')
  checked += 1
  // `export {}` keeps an import-free block a module, so its top-level await is legal.
  writeFileSync(join(DIR, `block${index}.ts`), `${body}\nexport {}\n`)
})

writeFileSync(
  join(DIR, "tsconfig.json"),
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
      include: ["*.ts"],
    },
    null,
    2,
  ),
)

try {
  execFileSync("pnpm", ["tsc", "-p", join(DIR, "tsconfig.json")], { stdio: "inherit" })
  console.log(
    `README: ${checked} snippets type-check, ${skipped} skipped (agent frameworks)`,
  )
} finally {
  rmSync(DIR, { recursive: true, force: true })
}
