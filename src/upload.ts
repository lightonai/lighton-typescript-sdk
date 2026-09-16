/**
 * Turning a caller's file into a multipart part.
 *
 * `node:fs` is imported lazily, inside the path branch only, so the SDK still loads in a
 * browser, a Worker, or any runtime without it. Callers there pass a `Blob` instead and
 * never reach the import.
 */

/** A local path (Node-family runtimes), a `File`/`Blob`, or a `Blob` with a name. */
export type FileSource = string | Blob | { filename: string; blob: Blob }

export interface FilePart {
  filename: string
  blob: Blob
}

/** Last path segment, without needing `node:path` (which a browser build can't have). */
export function basename(pathname: string): string {
  return pathname.split(/[\\/]/).pop() || pathname
}

/**
 * Read a caller's file into a named `Blob`.
 *
 * The bytes are buffered rather than streamed: a 429 retry re-sends the same body, and a
 * consumed stream would re-send nothing. The Python SDK buffers on upload for exactly
 * this reason, and streams on parse/extract; buffering everywhere is both simpler and
 * strictly safer.
 *
 * @param source - A local path, a `File`, or an explicit `{filename, blob}` pair.
 * @returns The filename to send and the bytes to send under it.
 * @throws Error - If a path is given on a runtime without `node:fs`.
 */
export async function toFilePart(source: FileSource): Promise<FilePart> {
  if (typeof source === "string") {
    const { readFile } = await import("node:fs/promises").catch(() => {
      throw new Error(
        `cannot read the path ${JSON.stringify(source)}: this runtime has no filesystem. Pass a Blob or File instead.`,
      )
    })
    const bytes = await readFile(source)
    // Copy into a plain ArrayBuffer: node:fs may hand back a view onto a SharedArrayBuffer,
    // which BlobPart does not accept.
    const view = new Uint8Array(bytes.byteLength)
    view.set(bytes)
    return { filename: basename(source), blob: new Blob([view]) }
  }
  if (source instanceof Blob) {
    const name = source instanceof File ? source.name : ""
    if (!name) {
      throw new Error("a Blob needs a filename: pass { filename, blob } or a File")
    }
    return { filename: name, blob: source }
  }
  return { filename: source.filename, blob: source.blob }
}
