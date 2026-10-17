import { readdirSync } from "node:fs";
import { findSourceMap } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * With `--enable-source-maps` (scripts/start-production.sh), Node parses a
 * bundle chunk's source map the first time a stack trace passes through that
 * chunk. On a fresh process that already serves requests, this blocks the
 * event loop for hundreds of milliseconds. Each server calls this from its
 * `onReady` hook, inside `listen()` before the port opens. It parses the maps
 * of every chunk loaded so far, so that cost lands in boot. Node still parses
 * the maps of chunks imported later on first use. Does nothing when source
 * maps are off, and never throws.
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
      // Node caches ES modules by URL and CommonJS modules by path. A chunk
      // that is not loaded yet has neither, so the next call retries it.
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
