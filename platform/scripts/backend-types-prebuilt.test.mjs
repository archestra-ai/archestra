import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import {
  download,
  pack,
  restore,
  sourceKey,
} from "./backend-types-prebuilt.mjs";

let root;
const groups = ["backend", "shared", "tools/drizzle-migration-linter"];
function git(...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}
function write(file, text) {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, text);
}
function buildDir(group) {
  return path.join(root, "platform", group, ".tsbuild");
}
function artifact() {
  pack(root, path.join(root, "packed"));
  return fs.readFileSync(path.join(root, "packed/backend-types.json"), "utf8");
}
function clear() {
  for (const group of groups) fs.rmSync(buildDir(group), { recursive: true });
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "backend declarations "));
  git("init", "-q");
  write("platform/.gitignore", "node_modules/\n.tsbuild/\n");
  for (const group of groups) {
    write(
      `platform/${group}/source.ts`,
      "export const value: string = 'ok';\n",
    );
    write(
      `platform/${group}/.tsbuild/source.d.ts`,
      "export declare const value: string;\n",
    );
    write(`platform/${group}/.tsbuild/project.tsbuildinfo`, "{}");
  }
  git("add", "platform");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "fixture",
  );
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test("restores declarations portably while preserving an existing compiler's state", () => {
  const json = artifact();
  const commit = git("rev-parse", "HEAD").trim();
  clear();
  write("platform/shared/.tsbuild/local.d.ts", "local state");
  assert.equal(restore(root, json), commit);
  assert.equal(
    fs.readFileSync(path.join(buildDir("backend"), "source.d.ts"), "utf8"),
    "export declare const value: string;\n",
  );
  assert.equal(
    fs.readFileSync(path.join(buildDir("shared"), "local.d.ts"), "utf8"),
    "local state",
  );
  assert.equal(
    fs.existsSync(path.join(buildDir("shared"), "source.d.ts")),
    false,
  );
});

test("edited, deleted, untracked, and committed source changes cannot reuse stale success", () => {
  const json = artifact();
  const original = sourceKey(root);
  clear();
  for (const change of [
    () => write("platform/backend/source.ts", "changed"),
    () => fs.rmSync(path.join(root, "platform/backend/source.ts")),
    () => write("platform/backend/new.ts", "new source"),
  ]) {
    git("reset", "--hard", "-q", "HEAD");
    fs.rmSync(path.join(root, "platform/backend/new.ts"), { force: true });
    change();
    assert.throws(() => restore(root, json), /source does not match/);
    assert.equal(fs.existsSync(buildDir("backend")), false);
  }
  git("add", "platform");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "source changed",
  );
  assert.notEqual(sourceKey(root), original);
  assert.throws(() => restore(root, json), /source does not match/);
});

test("corrupt bytes, duplicate paths, and traversal are rejected before writing any output", () => {
  const original = JSON.parse(artifact());
  clear();
  for (const mutate of [
    (a) => {
      a.files.at(-1).data = Buffer.from("corrupt").toString("base64");
    },
    (a) => {
      a.files.push(a.files[0]);
    },
    (a) => {
      a.files.at(-1).path = "backend/.tsbuild/../../outside.d.ts";
    },
    (a) => {
      a.files.at(-1).path = "backend/.tsbuild/symlink.js";
    },
    (a) => {
      a.files = a.files.filter((file) => !file.path.startsWith("shared/"));
    },
  ]) {
    const a = structuredClone(original);
    mutate(a);
    assert.throws(() => restore(root, JSON.stringify(a)));
    for (const group of groups)
      assert.equal(fs.existsSync(buildDir(group)), false);
  }
});

test("a packed declaration cache remains usable after moving the checkout", () => {
  const compiler = fileURLToPath(
    new URL("../backend/node_modules/.bin/tsc", import.meta.url),
  );
  write(
    "platform/backend/tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        composite: true,
        declaration: true,
        emitDeclarationOnly: true,
        outDir: ".tsbuild",
        tsBuildInfoFile: ".tsbuild/project.tsbuildinfo",
        types: [],
      },
      files: ["source.ts"],
    }),
  );
  git("add", "platform");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "compiler config",
  );
  fs.rmSync(buildDir("backend"), { recursive: true });
  execFileSync(compiler, ["-b", "platform/backend/tsconfig.json"], {
    cwd: root,
  });
  const json = artifact();
  clear();
  const moved = `${root}-moved`;
  fs.renameSync(root, moved);
  root = moved;
  restore(root, json);
  const output = execFileSync(
    compiler,
    ["-b", "platform/backend/tsconfig.json", "--verbose"],
    { cwd: root, encoding: "utf8" },
  );
  assert.match(output, /up to date/);
  write("platform/backend/source.ts", "export const value: string = 42;\n");
  assert.throws(() =>
    execFileSync(compiler, ["-b", "platform/backend/tsconfig.json"], {
      cwd: root,
      stdio: "pipe",
    }),
  );
});

test("downloads an authenticated OCI index and rejects a corrupt layer", async () => {
  artifact();
  const bytes = execFileSync("tar", [
    "-czf",
    "-",
    "-C",
    path.join(root, "packed"),
    "backend-types.json",
  ]);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const imageDigest = `sha256:${"1".repeat(64)}`;
  let corrupt = false;
  let origin;
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url.startsWith("/token")) {
      assert.match(request.url, /scope=repository%3Acache%3Apull/);
      response.end(JSON.stringify({ token: "test-only-anonymous-token" }));
    } else if (
      request.headers.authorization !== "Bearer test-only-anonymous-token"
    ) {
      response
        .writeHead(401, {
          "www-authenticate": `Bearer realm="${origin}/token",service="fixture"`,
        })
        .end();
    } else if (request.url === `/v2/cache/manifests/${sourceKey(root)}`) {
      response.end(
        JSON.stringify({
          manifests: [
            {
              digest: imageDigest,
              platform: { os: "linux", architecture: "amd64" },
            },
          ],
        }),
      );
    } else if (request.url === `/v2/cache/manifests/${imageDigest}`) {
      response.end(
        JSON.stringify({ layers: [{ digest, size: bytes.length }] }),
      );
    } else if (request.url === `/v2/cache/blobs/${digest}`) {
      const layer = Buffer.from(bytes);
      if (corrupt) layer[0] ^= 1;
      response.end(layer);
    } else response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const json = await download(root, `${origin}/cache`);
    clear();
    restore(root, json);
    assert.equal(
      fs.existsSync(path.join(buildDir("backend"), "source.d.ts")),
      true,
    );
    corrupt = true;
    await assert.rejects(download(root, `${origin}/cache`), /digest mismatch/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
