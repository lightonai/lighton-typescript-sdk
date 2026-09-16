/**
 * Streaming `ask` events.
 *
 * `type` is a literal discriminator, so callers can `switch (event.type)` and get exact
 * narrowing on each branch.
 *
 * There is deliberately no error event: an `error` on the wire means the answer is
 * incomplete, so the SDK throws {@link StreamError} rather than handing back an event a
 * caller could quietly ignore and mistake for a finished answer.
 */

import type { AskResultItem } from "./index.ts"

/** The retrieved chunks, sent once before generation starts. */
export interface SourcesEvent {
  type: "sources"
  /** Retrieved chunks used as context, the same items `ask` returns. */
  results: AskResultItem[]
}

/** One chunk of the answer as it generates. */
export interface TokenEvent {
  type: "token"
  /** Answer text to append; may be several tokens. */
  text: string
}

/** Generation finished; no further events follow. */
export interface DoneEvent {
  type: "done"
}

export type AskEvent = SourcesEvent | TokenEvent | DoneEvent
