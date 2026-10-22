import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseLoadedSourceMaps } from "./source-maps";

describe("parseLoadedSourceMaps", () => {
  let directory: string;
  const sourceMapsWereEnabled = process.sourceMapsEnabled;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "source-maps-"));
  });

  afterEach(() => {
    process.setSourceMapsEnabled(sourceMapsWereEnabled);
    rmSync(directory, { recursive: true, force: true });
  });

  test("parses the map of each loaded chunk once and skips chunks not loaded", () => {
    process.setSourceMapsEnabled(true);
    const loaded = writeChunk(directory, "loaded.cjs");
    writeChunk(directory, "not-loaded.cjs");
    createRequire(import.meta.url)(loaded);

    expect(parseLoadedSourceMaps(directory)).toBe(1);
    expect(parseLoadedSourceMaps(directory)).toBe(0);
  });

  test("does nothing while source maps are off", () => {
    process.setSourceMapsEnabled(true);
    const loaded = writeChunk(directory, "off.cjs");
    createRequire(import.meta.url)(loaded);
    process.setSourceMapsEnabled(false);

    expect(parseLoadedSourceMaps(directory)).toBe(0);
  });

  test("does not throw for a directory it cannot read", () => {
    process.setSourceMapsEnabled(true);

    expect(parseLoadedSourceMaps(path.join(directory, "missing"))).toBe(0);
  });
});

/** A CommonJS chunk with an inline source map, as the bundler emits one. */
function writeChunk(directory: string, name: string) {
  const file = path.join(directory, name);
  const map = Buffer.from(
    JSON.stringify({
      version: 3,
      sources: ["chunk.ts"],
      names: [],
      mappings: "AAAA",
    }),
  ).toString("base64");
  writeFileSync(
    file,
    `module.exports = 1;\n//# sourceMappingURL=data:application/json;base64,${map}\n`,
  );
  return file;
}
