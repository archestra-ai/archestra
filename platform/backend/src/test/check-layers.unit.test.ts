import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

// scripts/check-layers.mjs against today's sources, with edited copies of the
// list of known upward imports.
const BACKEND_DIR = path.resolve(__dirname, "../..");
const KNOWN = path.join(BACKEND_DIR, "layers.known-upward-imports.json");

describe("check-layers", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("passes with the committed list of known upward imports", () => {
    const result = checkLayers(KNOWN);
    expect(result.status, result.stderr).toBe(0);
  });

  test("fails on an upward import the list does not know, and on a listed one that is gone", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-layers-"));
    const known = JSON.parse(fs.readFileSync(KNOWN, "utf8")) as string[];
    const [unlisted, ...rest] = known;
    const gone =
      "src/types/gone.ts -> src/config.ts (schema-imports-no-higher-layer)";
    const edited = path.join(dir, "known.json");
    fs.writeFileSync(edited, JSON.stringify([...rest, gone]));

    const result = checkLayers(edited);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `1 new import(s) from a lower backend layer to a higher one`,
    );
    expect(result.stderr).toContain(unlisted);
    expect(result.stderr).toContain(
      "1 listed upward import(s) no longer exist",
    );
    expect(result.stderr).toContain(gone);
  });
});

function checkLayers(knownFile: string) {
  return spawnSync(
    process.execPath,
    [path.join(BACKEND_DIR, "scripts/check-layers.mjs"), knownFile],
    { cwd: BACKEND_DIR, encoding: "utf8" },
  );
}
