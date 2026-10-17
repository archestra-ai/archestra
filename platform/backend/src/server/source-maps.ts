import { readdirSync } from "node:fs";
import { findSourceMap } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * With `--enable-source-maps` (scripts/start-production.sh), Node parses a
 * bundle chunk's source map the first time a stack trace passes through that
 * chunk, which blocks the event loop for hundreds of milliseconds on a fresh
 * process that is already serving. Called from each server's `onReady`, inside
 * `listen()` before the port opens, this parses the maps of every chunk loaded
 * so far, so that cost lands in boot. Chunks imported later parse lazily as
 * before. Does nothing when source maps are off, and never throws.
 *
 * Returns how many chunk maps this call parsed.
 */
export function parseLoadedSourceMaps(
  chunkDirectory = path.dirname(path.resolve(process.argv[1] ?? "")),
): number {
  if (!process.sourceMapsEnabled) return 0;
  let count = 0;
  try {
    for (const name of readdirSync(chunkDirectory)) {
      if (!/\.(?:mjs|cjs|js)$/.test(name)) continue;
      const file = path.join(chunkDirectory, name);
      if (parsedChunks.has(file)) continue;
      // ES modules are cached by URL, CommonJS by path; a chunk not loaded
      // yet has neither and is retried on the next call.
      if (findSourceMap(pathToFileURL(file).href) ?? findSourceMap(file)) {
        parsedChunks.add(file);
        count++;
      }
    }
  } catch {
    // Never let an optimization stop a server from starting.
  }
  return count;
}

// === Internal helpers

const parsedChunks = new Set<string>();
