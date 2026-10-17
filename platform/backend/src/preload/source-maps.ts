/**
 * Loaded with `node --import` ahead of the server (see
 * scripts/start-production.sh). With `--enable-source-maps`, Node parses a
 * bundle chunk's source map the first time a stack trace passes through that
 * chunk, which blocks the event loop for hundreds of milliseconds on a fresh
 * process that is already serving requests. This parses the maps of every
 * loaded chunk just before a server starts listening, so that cost lands in
 * boot instead. It does nothing when source maps are off and never throws.
 */
import { readdirSync } from "node:fs";
import { findSourceMap } from "node:module";
import { Server } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (process.sourceMapsEnabled) {
  try {
    // The entry script's directory holds the bundle chunks it imports.
    const chunkDirectory = path.dirname(path.resolve(process.argv[1] ?? ""));
    const parsed = new Set<string>();
    const listen = Server.prototype.listen;
    Server.prototype.listen = function (
      this: Server,
      ...args: Parameters<Server["listen"]>
    ) {
      parseLoadedSourceMaps({ chunkDirectory, parsed });
      return listen.apply(this, args);
    } as Server["listen"];
  } catch {
    // Stack traces still map lazily; only the timing of the parse changes.
  }
}

// === Internal helpers

function parseLoadedSourceMaps(params: {
  chunkDirectory: string;
  parsed: Set<string>;
}) {
  try {
    for (const name of readdirSync(params.chunkDirectory)) {
      if (!name.endsWith(".mjs") || params.parsed.has(name)) continue;
      // A chunk not imported yet has no cached map; it is retried on the
      // next listen and otherwise parses lazily as before.
      const url = pathToFileURL(path.join(params.chunkDirectory, name)).href;
      if (findSourceMap(url)) params.parsed.add(name);
    }
  } catch {
    // Never let an optimization stop a server from listening.
  }
}
