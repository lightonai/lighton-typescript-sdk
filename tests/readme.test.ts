/**
 * The README's Contents list, pinned to its headings.
 *
 * AGENTS.md asks for the two to stay in sync. A test enforces it, which a convention
 * alone does not: the list drifts silently and nobody notices until a link 404s.
 */

import { readFileSync } from "node:fs"
import { expect, test } from "vitest"

const README = readFileSync(new URL("../README.md", import.meta.url), "utf8")

/** GitHub's heading-anchor rule, enough of it for the headings we use. */
const slug = (heading: string): string =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/ /g, "-")

const contents = [...README.matchAll(/^- \[([^\]]+)\]\(#([^)]+)\)$/gm)].map((m) => ({
  title: m[1] as string,
  anchor: m[2] as string,
}))

// "What is LightOn?" and "Contents" sit above the list and are not part of it.
const headings = [...README.matchAll(/^## (.+)$/gm)]
  .map((m) => m[1] as string)
  .filter((h) => h !== "What is LightOn?" && h !== "Contents")

test("the Contents list matches the headings, in order", () => {
  expect(contents.map((entry) => entry.title)).toEqual(headings)
})

test("every Contents anchor resolves to its heading", () => {
  for (const entry of contents) {
    expect(entry.anchor, `anchor for "${entry.title}"`).toBe(slug(entry.title))
  }
})

test("documentation carries no em-dashes", () => {
  // A house rule from AGENTS.md: use a comma, a colon, parentheses, or two sentences.
  for (const file of ["README.md", "AGENTS.md", "CONTRIBUTING.md", "CLAUDE.md"]) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
    expect(text.includes("—"), `${file} contains an em-dash`).toBe(false)
  }
})
