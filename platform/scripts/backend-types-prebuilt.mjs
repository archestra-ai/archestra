#!/usr/bin/env node
// Portable declarations for a clean, exact-source checkout. No ancestor cache:
// restored build-info timestamps must never hide an edited or deleted source.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REPOSITORY = "ghcr.io/archestra-ai/ci/backend-types-cache";
const GROUPS = ["backend", "shared", "tools/drizzle-migration-linter"];
const INPUTS = ["platform", ".github/workflows/on-commits-to-main.yml"];
const MAX_BYTES = 256 * 1024 ** 2;

export function sourceKey(root) {
  return digest(
    [
      "backend-types 1",
      process.platform,
      process.arch,
      ...git(root, "ls-tree", "HEAD", "--", ...INPUTS).split("\n"),
    ].join("\n"),
  );
}

function clean(root) {
  return !git(
    root,
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    ...INPUTS,
  );
}
function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: MAX_BYTES,
  }).trimEnd();
}
function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function buildDir(root, group) {
  return path.join(root, "platform", group, ".tsbuild");
}
function validPath(name) {
  return (
    typeof name === "string" &&
    GROUPS.some((group) => name.startsWith(`${group}/.tsbuild/`)) &&
    !name.split("/").some((part) => !part || part === "." || part === "..") &&
    !name.includes("\\") &&
    /\.(d\.ts(?:\.map)?|tsbuildinfo)$/.test(name)
  );
}

export function pack(root, directory) {
  if (!clean(root)) throw new Error("type-check inputs have local changes");
  const files = [];
  function visit(dir, relative) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file, name);
      else {
        if (!entry.isFile() || !validPath(name))
          throw new Error(`unexpected build output: ${name}`);
        const bytes = fs.readFileSync(file);
        files.push({
          path: name,
          sha256: digest(bytes),
          data: bytes.toString("base64"),
        });
      }
    }
  }
  for (const group of GROUPS) visit(buildDir(root, group), `${group}/.tsbuild`);
  if (!files.some((file) => file.path.startsWith("backend/.tsbuild/")))
    throw new Error("no backend declarations");
  const artifact = {
    key: sourceKey(root),
    commit: git(root, "rev-parse", "HEAD"),
    files,
  };
  const json = JSON.stringify(artifact);
  if (Buffer.byteLength(json) > MAX_BYTES)
    throw new Error("declaration cache is too large");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "backend-types.json"), json);
  return artifact.key;
}

// Validate every byte and destination before writing anything. There are no tar
// filesystem extractions, symlinks, or arbitrary paths from the registry.
export function restore(root, json) {
  if (Buffer.byteLength(json) > MAX_BYTES)
    throw new Error("declaration cache is too large");
  const artifact = JSON.parse(json);
  if (artifact.key !== sourceKey(root) || !clean(root))
    throw new Error("source does not match cache");
  if (
    !Array.isArray(artifact.files) ||
    !artifact.files.length ||
    !/^[0-9a-f]{40}$/.test(artifact.commit)
  )
    throw new Error("invalid cache manifest");
  const seen = new Set();
  const files = artifact.files.map((file) => {
    if (
      !validPath(file.path) ||
      seen.has(file.path) ||
      typeof file.data !== "string"
    )
      throw new Error("invalid cache path");
    seen.add(file.path);
    const bytes = Buffer.from(file.data, "base64");
    if (digest(bytes) !== file.sha256)
      throw new Error("cache file digest mismatch");
    return { path: file.path, bytes };
  });
  for (const group of GROUPS) {
    const destination = buildDir(root, group);
    // Preserve incremental work, including state another checker just created.
    if (fs.existsSync(destination)) continue;
    const selected = files.filter((file) =>
      file.path.startsWith(`${group}/.tsbuild/`),
    );
    if (!selected.length) throw new Error(`cache is missing ${group}`);
  }
  const cacheRoot = path.join(root, "platform", "node_modules");
  fs.mkdirSync(cacheRoot, { recursive: true });
  const staging = fs.mkdtempSync(path.join(cacheRoot, ".backend-types-"));
  try {
    for (const file of files) {
      const destination = path.join(staging, file.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, file.bytes);
    }
    // TypeScript compares config/source/declaration mtimes to build-info. All
    // inputs already exist and match the key; build-info must be newest.
    const now = new Date();
    for (const file of files.filter((file) =>
      file.path.endsWith(".tsbuildinfo"),
    ))
      fs.utimesSync(path.join(staging, file.path), now, now);
    if (!clean(root) || artifact.key !== sourceKey(root))
      throw new Error("source changed during download");
    for (const group of GROUPS) {
      const destination = buildDir(root, group);
      if (fs.existsSync(destination)) continue;
      fs.renameSync(path.join(staging, group, ".tsbuild"), destination);
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return artifact.commit;
}

export async function download(root = ROOT, repository = REPOSITORY) {
  const registry = new URL(
    /^https?:\/\//.test(repository) ? repository : `https://${repository}`,
  );
  const name = registry.pathname.replace(/^\/+|\/+$/g, "");
  const base = `${registry.origin}/v2/${name}`;
  const accept = [
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
  ].join(", ");
  let token;
  async function get(url, accept) {
    let response = await fetch(url, {
      headers: {
        accept,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401 && !token) {
      const challenge = response.headers.get("www-authenticate") ?? "";
      const realm = /realm="([^"]+)"/.exec(challenge)?.[1];
      if (!realm) throw new Error("registry requires credentials");
      const auth = new URL(realm);
      const service = /service="([^"]+)"/.exec(challenge)?.[1];
      if (service) auth.searchParams.set("service", service);
      auth.searchParams.set("scope", `repository:${name}:pull`);
      const reply = await fetch(auth, { signal: AbortSignal.timeout(30_000) });
      if (!reply.ok) throw new Error(`registry token: ${reply.status}`);
      const body = await reply.json();
      token = body.token ?? body.access_token;
      if (!token) throw new Error("no anonymous registry token");
      response = await get(url, accept);
    }
    if (!response.ok) throw new Error(`registry: ${response.status}`);
    return response;
  }
  const response = await get(`${base}/manifests/${sourceKey(root)}`, accept);
  let manifest = await response.json();
  if (Array.isArray(manifest.manifests)) {
    const entry = manifest.manifests.find(
      (item) =>
        item.platform?.os === "linux" &&
        item.platform?.architecture === "amd64",
    );
    if (!/^sha256:[0-9a-f]{64}$/.test(entry?.digest ?? "")) {
      throw new Error("cache has no linux/amd64 image");
    }
    manifest = await (
      await get(`${base}/manifests/${entry.digest}`, accept)
    ).json();
  }
  if (
    manifest.layers?.length !== 1 ||
    !/^sha256:[0-9a-f]{64}$/.test(manifest.layers[0].digest)
  )
    throw new Error("unexpected registry layout");
  const layer = manifest.layers[0];
  if (!(layer.size > 0 && layer.size <= MAX_BYTES))
    throw new Error("cache layer too large");
  const blob = await get(`${base}/blobs/${layer.digest}`, "*/*");
  const chunks = [];
  let size = 0;
  for await (const chunk of blob.body) {
    size += chunk.length;
    if (size > layer.size) throw new Error("cache exceeds declared size");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (size !== layer.size || `sha256:${digest(bytes)}` !== layer.digest)
    throw new Error("cache layer digest mismatch");
  // -O returns only file bytes: tar never writes paths or links to the checkout.
  return execFileSync("tar", ["-xzOf", "-", "backend-types.json"], {
    input: bytes,
    maxBuffer: MAX_BYTES,
    encoding: "utf8",
  });
}

async function main() {
  const [command, directory] = process.argv.slice(2);
  if (command === "--key") console.log(sourceKey(ROOT));
  else if (command === "--pack") console.log(pack(ROOT, directory));
  else if (command === "install") {
    if (
      process.platform !== "linux" ||
      process.arch !== "x64" ||
      fs.existsSync(buildDir(ROOT, "backend")) ||
      !clean(ROOT)
    )
      return;
    const commit = restore(ROOT, await download());
    console.error(
      `backend-types-prebuilt: installed declarations from ${commit}`,
    );
  } else throw new Error("usage: --key | --pack <dir> | install");
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(
      `backend-types-prebuilt: ${error.message}; compiling locally`,
    );
    process.exitCode = 1;
  });
}
