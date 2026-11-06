import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

// Exercise the real CLI and dependency-cruiser on a small project. The normal
// `pnpm check:layers` command validates the full backend and committed baseline.
const BACKEND_DIR = path.resolve(__dirname, "../..");
const UPWARD = "src/lower.ts -> src/higher.ts (lower-imports-no-higher-layer)";
const GONE = "src/gone.ts -> src/higher.ts (lower-imports-no-higher-layer)";

describe("check-layers", () => {
  let dir: string | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-layers-"));
    fs.mkdirSync(path.join(dir, "scripts"));
    fs.mkdirSync(path.join(dir, "src"));
    fs.copyFileSync(
      path.join(BACKEND_DIR, "scripts/check-layers.mjs"),
      path.join(dir, "scripts/check-layers.mjs"),
    );
    fs.mkdirSync(path.join(dir, "node_modules/.bin"), { recursive: true });
    // pnpm's generated shell shim resolves paths relative to its invocation.
    // Link the actual executable so it keeps its installed dependencies.
    fs.symlinkSync(
      path.join(
        BACKEND_DIR,
        "node_modules/dependency-cruiser/bin/dependency-cruiser.mjs",
      ),
      path.join(dir, "node_modules/.bin/depcruise"),
    );
    fs.writeFileSync(
      path.join(dir, "src/lower.ts"),
      'import type { Higher } from "./higher.ts"; export type Lower = Higher;\n',
    );
    fs.writeFileSync(
      path.join(dir, "src/higher.ts"),
      "export type Higher = string;\n",
    );
    fs.writeFileSync(path.join(dir, "src/composition.ts"), "export {};\n");
    fs.writeFileSync(
      path.join(dir, "src/entry.ts"),
      'import "./composition.ts";\n',
    );
    fs.writeFileSync(
      path.join(dir, "layers.mjs"),
      `export default ${JSON.stringify({
        forbidden: [
          {
            name: "lower-imports-no-higher-layer",
            severity: "error",
            from: { path: "^src/lower\\.ts$" },
            to: { path: "^src/higher\\.ts$" },
          },
        ],
        required: [
          {
            name: "entry-point-binds-ports",
            severity: "error",
            module: { path: "^src/entry\\.ts$" },
            to: { path: "^src/composition\\.ts$" },
          },
        ],
        options: { tsPreCompilationDeps: true },
      })};\n`,
    );
  });

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("fails on an unlisted upward type import and a stale listed import; an update only shrinks the list", () => {
    if (!dir) throw new Error("fixture missing");
    const edited = path.join(dir, "known.json");
    fs.writeFileSync(edited, JSON.stringify([GONE]));

    const check = checkLayers(dir);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain(
      "1 new violation(s) of the backend's layer order",
    );
    expect(check.stderr).toContain(UPWARD);
    expect(check.stderr).toContain("1 listed upward import(s) no longer exist");
    expect(check.stderr).toContain(GONE);

    // The update refuses to list the new import, and leaves the file alone.
    const update = checkLayers(dir, "--update");
    expect(update.status).toBe(1);
    expect(update.stderr).toContain("the list may only shrink");
    expect(JSON.parse(fs.readFileSync(edited, "utf8"))).toEqual([GONE]);

    fs.writeFileSync(edited, JSON.stringify([UPWARD, GONE]));
    const shrink = checkLayers(dir, "--update");
    expect(shrink.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(edited, "utf8"))).toEqual([UPWARD]);
  });

  test("fails on a module that misses a required import, and never lists it, even with --allow-new", () => {
    if (!dir) throw new Error("fixture missing");
    fs.writeFileSync(path.join(dir, "src/entry.ts"), "export {};\n");
    const edited = path.join(dir, "known.json");
    const original = JSON.stringify([UPWARD]);
    fs.writeFileSync(edited, original);
    const missing = "src/entry.ts (entry-point-binds-ports)";

    const check = checkLayers(dir);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain(
      "1 module(s) miss a required import (layers.mjs `required`)",
    );
    expect(check.stderr).toContain(missing);

    const update = checkLayers(dir, "--update", "--allow-new");
    expect(update.status).toBe(1);
    expect(update.stderr).toContain(missing);
    expect(fs.readFileSync(edited, "utf8")).toBe(original);
  });
});

function checkLayers(root: string, ...args: string[]) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "scripts/check-layers.mjs"),
      "--layers",
      path.join(root, "layers.mjs"),
      "--known",
      path.join(root, "known.json"),
      ...args,
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  return result;
}
