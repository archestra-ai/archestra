import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

// scripts/check-layers.mjs against today's sources, with an edited copy of
// the list of known upward imports. `pnpm check:layers` covers the committed
// list itself.
const BACKEND_DIR = path.resolve(__dirname, "../..");
const KNOWN = path.join(BACKEND_DIR, "layers.known-upward-imports.json");
const GONE =
  "src/types/gone.ts -> src/config.ts (schema-imports-no-higher-layer)";

describe("check-layers", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("fails on an upward import the list does not know and on a listed one that is gone; an update only shrinks the list", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-layers-"));
    const [unlisted, ...rest] = JSON.parse(
      fs.readFileSync(KNOWN, "utf8"),
    ) as string[];
    const edited = path.join(dir, "known.json");
    fs.writeFileSync(edited, JSON.stringify([...rest, GONE]));

    const check = checkLayers("--known", edited);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain(
      "1 new violation(s) of the backend's layer order",
    );
    expect(check.stderr).toContain(unlisted);
    expect(check.stderr).toContain("1 listed upward import(s) no longer exist");
    expect(check.stderr).toContain(GONE);

    // The update refuses to list the new import, and leaves the file alone.
    const update = checkLayers("--update", "--known", edited);
    expect(update.status).toBe(1);
    expect(update.stderr).toContain("the list may only shrink");
    expect(JSON.parse(fs.readFileSync(edited, "utf8"))).toContain(GONE);
  });
});

function checkLayers(...args: string[]) {
  return spawnSync(
    process.execPath,
    [path.join(BACKEND_DIR, "scripts/check-layers.mjs"), ...args],
    { cwd: BACKEND_DIR, encoding: "utf8" },
  );
}
