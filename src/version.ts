// Replaced at build time by tsdown's `define`, from package.json. The `typeof` guard is
// what keeps this working unbundled (vitest, `node --experimental-strip-types`), where
// the identifier is never declared.
declare const __SDK_VERSION__: string

export const VERSION =
  typeof __SDK_VERSION__ === "string" ? __SDK_VERSION__ : "0.0.0-dev"
