/**
 * Builds the PGlite test snapshot at the path given as the only argument.
 * global-setup.ts runs it as a child process: see pglite-snapshot.ts.
 */
import { buildSnapshot } from "./pglite-snapshot.js";

const outPath = process.argv[2];
if (!outPath) {
  throw new Error("usage: build-pglite-snapshot.ts <output .tar.gz>");
}
await buildSnapshot(outPath);
