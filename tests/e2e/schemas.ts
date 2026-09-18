/** Extraction and answer schemas used by the e2e run. */

import { z } from "zod"

/** Doc-agnostic extraction schema, flat: no sub-schemas, so no `$defs`/`$ref`. */
export const DocumentSummary = z.object({
  title: z.string().describe("Document title."),
  summary: z.string().describe("One-sentence summary of the document."),
  language: z.string().describe("Primary language, as an ISO 639-1 code."),
})

/** A section heading; sub-schema of {@link DocumentOutline}. */
export const Section = z.object({
  heading: z.string().describe("Section heading, verbatim as written."),
  page: z.number().nullable().describe("Page it starts on; null if unclear."),
})

/**
 * Nested schema: converting it emits `$defs`/`$ref` for both sub-schemas.
 *
 * The API rejects `$ref`, so this only reaches it because the SDK inlines them. It
 * reuses `DocumentSummary` on purpose, so the same schema appears both nested and
 * standalone.
 */
export const DocumentOutline = z.object({
  overview: DocumentSummary.describe("Summary of the whole document."),
  sections: z.array(Section).describe("Every top-level section heading."),
})

/** `ask({ schema })` structured output: the answer is constrained to this. */
export const GroundedAnswer = z.object({
  answer: z.string().describe("The answer, in one or two sentences."),
  confident: z.boolean().describe("True if the sources fully support it."),
})
