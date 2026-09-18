/**
 * Step selection for the e2e runner.
 *
 * The runner itself needs a live API, but which steps it picks is plain logic with three
 * interacting rules, so it is pinned here.
 */

import { expect, test } from "vitest"
import { chooseSteps } from "./e2e/cli.ts"

const ALL = ["workspace", "upload", "tags", "search", "batch"]

test("no flags runs every step, in definition order", () => {
  expect(chooseSteps(ALL, [], [])).toEqual(ALL)
})

test("--only pulls in the prerequisites", () => {
  // Every other step needs a workspace with a file in it, so asking for one step alone
  // would otherwise fail on a missing prerequisite rather than on the feature.
  expect(chooseSteps(ALL, ["search"], [])).toEqual(["workspace", "upload", "search"])
})

test("--only keeps definition order, not the order given", () => {
  expect(chooseSteps(ALL, ["batch", "tags"], [])).toEqual([
    "workspace",
    "upload",
    "tags",
    "batch",
  ])
})

test("--skip removes a step", () => {
  expect(chooseSteps(ALL, [], ["batch"])).toEqual([
    "workspace",
    "upload",
    "tags",
    "search",
  ])
})

test("--skip wins over the implied prerequisites", () => {
  // The prerequisites are auto-added for convenience, not forced on you.
  expect(chooseSteps(ALL, ["search"], ["upload"])).toEqual(["workspace", "search"])
})

test("--only and --skip combine", () => {
  expect(chooseSteps(ALL, ["tags", "search"], ["tags"])).toEqual([
    "workspace",
    "upload",
    "search",
  ])
})
