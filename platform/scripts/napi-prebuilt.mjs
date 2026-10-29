#!/usr/bin/env node
// Prebuilt native addons for the dev stack.
//
// CI builds the five napi addons (`pnpm build:dev`, Debian bookworm, linux
// x64 glibc) for every `main` tree of archestra-rs and publishes them as an
// OCI artifact in the public registry, tagged with the key below. A dev stack
// on a checkout whose archestra-rs tree matches a published one installs
// those binaries instead of compiling them (about 3.5 minutes of 7 CPUs).
//
//   node scripts/napi-prebuilt.mjs <package>...   install, e.g. app-runtime-rs
//   node scripts/napi-prebuilt.mjs --key          print the cache key
//   node scripts/napi-prebuilt.mjs --pack <dir>   CI: collect the built addons
//
// Install exits 0 when every requested addon is in place and 1 when the
// caller has to build: another platform, a modified archestra-rs tree, no
// published entry, a network error, or ARCHESTRA_NAPI_PREBUILT=false.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGES = [
  "app-runtime-rs",
  "image-rs",
  "openappa-rs",
  "router-rs",
  "sandbox-rs",
];
const BINARY = "index.linux-x64-gnu.node";
const STAMP = ".napi-prebuilt";
const DEFAULT_REPOSITORY =
  "europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/napi-dev-cache";
const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const platformDir = fileURLToPath(new URL("../", import.meta.url));
const rustDir = path.join(platformDir, "archestra-rs");

try {
  const [first, ...rest] = process.argv.slice(2);
  if (first === "--key") {
    console.log(cacheKey());
  } else if (first === "--pack") {
    pack(rest[0]);
  } else {
    process.exitCode = (await install([first, ...rest].filter(Boolean)))
      ? 0
      : 1;
  }
} catch (error) {
  console.error(`napi-prebuilt: ${error.message}`);
  process.exitCode = 1;
}

/** Tree IDs cover every tracked input of the addons; the toolchain sits outside. */
function cacheKey() {
  const [tree, toolchain] = git(
    "rev-parse",
    "HEAD:platform/archestra-rs",
    "HEAD:platform/rust-toolchain.toml",
  ).split("\n");
  return `${tree}-${toolchain.slice(0, 12)}`;
}

function treeIsClean() {
  return (
    git(
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      "archestra-rs",
      "rust-toolchain.toml",
    ) === ""
  );
}

function git(...args) {
  return execFileSync("git", ["-C", platformDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function pack(outDir) {
  if (!outDir) throw new Error("usage: --pack <dir>");
  if (!treeIsClean()) throw new Error("archestra-rs has local changes");
  const files = {};
  for (const name of PACKAGES) {
    const binary = path.join(rustDir, name, BINARY);
    mkdirSync(path.join(outDir, name), { recursive: true });
    copyFileSync(binary, path.join(outDir, name, BINARY));
    files[`${name}/${BINARY}`] = sha256(readFileSync(binary));
  }
  const manifest = { key: cacheKey(), commit: git("rev-parse", "HEAD"), files };
  writeFileSync(
    path.join(outDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(manifest.key);
}

async function install(names) {
  const unknown = names.filter((name) => !PACKAGES.includes(name));
  if (names.length === 0 || unknown.length) {
    throw new Error(`usage: <package>... from ${PACKAGES.join(", ")}`);
  }
  // Whenever this returns false the caller builds, so a stamp from an earlier
  // install must not vouch for whatever cargo writes next.
  const clearStamps = () => {
    for (const name of names)
      rmSync(path.join(rustDir, name, STAMP), { force: true });
  };
  if (process.env.ARCHESTRA_NAPI_PREBUILT === "false") {
    clearStamps();
    return false;
  }
  if (
    process.platform !== "linux" ||
    process.arch !== "x64" ||
    !process.report?.getReport().header.glibcVersionRuntime
  ) {
    clearStamps();
    return false;
  }
  let key;
  try {
    if (!treeIsClean()) {
      console.error("napi-prebuilt: archestra-rs has local changes; building");
      clearStamps();
      return false;
    }
    key = cacheKey();
  } catch {
    clearStamps();
    return false;
  }

  const missing = names.filter((name) => !installed(name, key));
  if (missing.length === 0) return true;

  const repository =
    process.env.ARCHESTRA_NAPI_PREBUILT_REPOSITORY || DEFAULT_REPOSITORY;
  let artifact;
  try {
    artifact = await download(repository, key);
  } catch (error) {
    console.error(`napi-prebuilt: ${error.message}; building`);
    clearStamps();
    return false;
  }
  if (!artifact) {
    console.error(`napi-prebuilt: no prebuilt addons for ${key}; building`);
    clearStamps();
    return false;
  }
  try {
    for (const name of missing) {
      const file = `${name}/${BINARY}`;
      const binary = readFileSync(path.join(artifact.dir, file));
      if (artifact.manifest.files[file] !== sha256(binary)) {
        throw new Error(`${file} does not match the artifact manifest`);
      }
      const target = path.join(rustDir, name, BINARY);
      // Rename over the old file: a running backend keeps the inode it mapped.
      writeFileSync(`${target}.tmp`, binary);
      renameSync(`${target}.tmp`, target);
      writeFileSync(
        path.join(rustDir, name, STAMP),
        `${key} ${sha256(binary)}\n`,
      );
    }
  } finally {
    rmSync(artifact.dir, { recursive: true, force: true });
  }
  console.error(`napi-prebuilt: installed ${missing.join(", ")} for ${key}`);
  return true;
}

/** The addon is the one an earlier install wrote for this key, byte for byte. */
function installed(name, key) {
  const stamp = path.join(rustDir, name, STAMP);
  const binary = path.join(rustDir, name, BINARY);
  if (!existsSync(stamp) || !existsSync(binary)) return false;
  const [stampKey, stampHash] = readFileSync(stamp, "utf8").trim().split(" ");
  return stampKey === key && stampHash === sha256(readFileSync(binary));
}

async function download(repository, key) {
  // `host/name`, or a URL with a scheme for a local test registry.
  const url = new URL(
    /^https?:\/\//.test(repository) ? repository : `https://${repository}`,
  );
  const name = url.pathname.replace(/^\/+|\/+$/g, "");
  const base = `${url.origin}/v2/${name}`;
  let token;
  const get = async (url, accept) => {
    const headers = { accept };
    if (token) headers.authorization = `Bearer ${token}`;
    let response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status === 401 && !token) {
      token = await anonymousToken(
        response.headers.get("www-authenticate"),
        name,
      );
      headers.authorization = `Bearer ${token}`;
      response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(60_000),
      });
    }
    return response;
  };

  let response = await get(`${base}/manifests/${key}`, MANIFEST_TYPES);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`registry answered ${response.status}`);
  let manifest = await response.json();
  if (manifest.manifests) {
    const entry = manifest.manifests.find(
      (m) => m.platform?.os === "linux" && m.platform?.architecture === "amd64",
    );
    if (!entry) throw new Error("artifact has no linux/amd64 manifest");
    response = await get(`${base}/manifests/${entry.digest}`, MANIFEST_TYPES);
    if (!response.ok) throw new Error(`registry answered ${response.status}`);
    manifest = await response.json();
  }
  if (manifest.layers?.length !== 1)
    throw new Error("unexpected artifact layout");
  const layer = manifest.layers[0];
  response = await get(`${base}/blobs/${layer.digest}`, "*/*");
  if (!response.ok) throw new Error(`registry answered ${response.status}`);
  const blob = Buffer.from(await response.arrayBuffer());
  if (`sha256:${sha256(blob)}` !== layer.digest) {
    throw new Error("downloaded layer does not match its digest");
  }

  const dir = mkdtempSync(path.join(tmpdir(), "napi-prebuilt-"));
  try {
    writeFileSync(path.join(dir, "layer.tar.gz"), blob);
    execFileSync("tar", ["-xzf", "layer.tar.gz"], {
      cwd: dir,
      stdio: "ignore",
    });
    const artifactManifest = JSON.parse(
      readFileSync(path.join(dir, "manifest.json"), "utf8"),
    );
    if (artifactManifest.key !== key)
      throw new Error("artifact manifest names another key");
    return { dir, manifest: artifactManifest };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

async function anonymousToken(challenge, name) {
  const realm = /realm="([^"]+)"/.exec(challenge ?? "")?.[1];
  if (!realm) throw new Error("registry requires credentials");
  const service = /service="([^"]+)"/.exec(challenge)?.[1];
  const url = new URL(realm);
  if (service) url.searchParams.set("service", service);
  url.searchParams.set("scope", `repository:${name}:pull`);
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok)
    throw new Error(`token endpoint answered ${response.status}`);
  const body = await response.json();
  return body.token ?? body.access_token;
}
