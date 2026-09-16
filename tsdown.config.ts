import { readFileSync } from "node:fs"
import { defineConfig } from "tsdown"

const pkg = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string }

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  target: "node22",
  // Single source of truth for the version: package.json, as the Python SDK single-sources
  // it from pyproject.toml. Importing package.json at runtime breaks the dual build.
  define: { __SDK_VERSION__: JSON.stringify(pkg.version) },
})
