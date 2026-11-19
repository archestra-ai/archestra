import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

const script = path.join(import.meta.dirname, "prune-backend-deploy.mjs");
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removes optional peers and what only they reach, keeps shared and hoist-only packages", () => {
  const root = deployTree();
  const result = prune(root);
  assert.equal(result.status, 0, result.stderr);

  const store = path.join(root, "node_modules/.pnpm");
  for (const gone of ["next@16", "@next+swc@16", "vitest@4", "msw@2"]) {
    assert.equal(existsSync(path.join(store, gone)), false, gone);
  }
  // still reached by a production dependency
  assert.ok(existsSync(path.join(store, "react@19/node_modules/react/index.js")));
  // only reachable through pnpm's hoisted links: left alone
  assert.ok(existsSync(path.join(store, "phantom@1/node_modules/phantom/index.js")));
  assert.ok(existsSync(path.join(store, "better-auth@1/node_modules/better-auth/index.js")));
  assert.equal(existsSync(path.join(store, "node_modules/next")), false);
});

test("strips third-party maps and declarations, keeps the server's own maps and TypeScript's libs", () => {
  const root = deployTree();
  assert.equal(prune(root).status, 0);

  const pkg = path.join(root, "node_modules/.pnpm/better-auth@1/node_modules/better-auth");
  assert.equal(existsSync(path.join(pkg, "index.js.map")), false);
  assert.equal(existsSync(path.join(pkg, "index.d.ts")), false);
  assert.ok(existsSync(path.join(root, "dist/server.mjs.map")));
  assert.ok(
    existsSync(path.join(root, "node_modules/.pnpm/typescript@6/node_modules/typescript/lib/lib.d.ts")),
  );
});

test("fails without touching the tree when the bundle imports a removed peer", () => {
  const root = deployTree();
  writeFileSync(path.join(root, "dist/chunk.mjs"), 'import { headers } from "next/headers";\n');
  const result = prune(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /imports next/);
  assert.ok(existsSync(path.join(root, "node_modules/.pnpm/next@16/node_modules/next/index.js")));
});

// === Internal helpers

function prune(root) {
  return spawnSync(process.execPath, [script, root], { encoding: "utf8" });
}

/**
 * A minimal `pnpm deploy` layout: better-auth (a production dependency) links
 * its optional peers next and vitest; react is shared with a production
 * dependency; phantom is only in pnpm's hoisted directory.
 */
function deployTree() {
  const root = mkdtempSync(path.join(tmpdir(), "prune-deploy-"));
  roots.push(root);
  const store = path.join(root, "node_modules/.pnpm");

  const pkg = (id, name, files = ["index.js"]) => {
    const dir = path.join(store, id, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    for (const file of files) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), "");
    }
  };
  const link = (fromId, name, toId) => {
    const at = path.join(store, fromId, "node_modules", name);
    mkdirSync(path.dirname(at), { recursive: true });
    symlinkSync(path.join(store, toId, "node_modules", name), at, "dir");
  };

  pkg("better-auth@1", "better-auth", ["index.js", "index.js.map", "index.d.ts"]);
  pkg("next@16", "next");
  pkg("@next+swc@16", "@next/swc");
  pkg("vitest@4", "vitest");
  pkg("msw@2", "msw");
  pkg("react@19", "react");
  pkg("phantom@1", "phantom");
  pkg("typescript@6", "typescript", ["lib/lib.d.ts"]);
  link("better-auth@1", "next", "next@16");
  link("better-auth@1", "vitest", "vitest@4");
  link("better-auth@1", "react", "react@19");
  link("next@16", "@next/swc", "@next+swc@16");
  link("next@16", "react", "react@19");
  link("vitest@4", "msw", "msw@2");

  const hoisted = path.join(store, "node_modules");
  mkdirSync(hoisted, { recursive: true });
  symlinkSync(path.join(store, "next@16/node_modules/next"), path.join(hoisted, "next"), "dir");
  symlinkSync(path.join(store, "phantom@1/node_modules/phantom"), path.join(hoisted, "phantom"), "dir");

  symlinkSync(
    path.join(store, "better-auth@1/node_modules/better-auth"),
    path.join(root, "node_modules/better-auth"),
    "dir",
  );
  symlinkSync(path.join(store, "react@19/node_modules/react"), path.join(root, "node_modules/react"), "dir");

  mkdirSync(path.join(root, "dist"));
  writeFileSync(path.join(root, "dist/server.mjs"), 'import "better-auth";\n');
  writeFileSync(path.join(root, "dist/server.mjs.map"), "{}");
  return root;
}
