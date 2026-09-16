import { expect, test } from "vitest"
import { VERSION } from "../src/version.ts"

test("exposes a version string", () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+/)
})
