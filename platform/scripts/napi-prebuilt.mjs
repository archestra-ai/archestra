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
// published entry, glibc older than 2.36, a network error, or
// ARCHESTRA_DEV_NAPI_PREBUILT=false.
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
  statSync,
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
const LOCK = ".napi-prebuilt.lock";
// CI builds on Debian bookworm; older glibc cannot load the binaries.
const MIN_GLIBC = "2.36";
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

/**
 * Tree IDs cover every tracked input of the addons. The toolchain file, the
 * lockfile (it pins the napi CLI that drives cargo) and the workflow that builds
 * them (its builder images and commands) sit outside.
 */
function cacheKey() {
  const [tree, toolchain, lockfile, recipe] = git(
    "rev-parse",
    "HEAD:platform/archestra-rs",
    "HEAD:platform/rust-toolchain.toml",
    "HEAD:platform/pnpm-lock.yaml",
    "HEAD:.github/workflows/napi-dev-cache.yml",
  ).split("\n");
  return [tree, toolchain, lockfile, recipe]
    .map((id, i) => (i ? id.slice(0, 12) : id))
    .join("-");
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
  if (process.env.ARCHESTRA_DEV_NAPI_PREBUILT === "false") return false;
  if (process.platform !== "linux" || process.arch !== "x64") return false;
  const glibc = process.report?.getReport().header.glibcVersionRuntime;
  if (!glibc || compareVersions(glibc, MIN_GLIBC) < 0) return false;
  let key;
  try {
    if (!treeIsClean()) {
      console.error("napi-prebuilt: archestra-rs has local changes; building");
      return false;
    }
    key = cacheKey();
  } catch {
    return false;
  }
  if (names.every((name) => installed(name, key))) return true;

  // Tilt starts every addon resource at once. The first run downloads the
  // artifact and installs all five addons; the others wait for it and then
  // find theirs in place.
  const release = await acquireLock();
  try {
    if (names.every((name) => installed(name, key))) return true;
    const repository =
      process.env.ARCHESTRA_DEV_NAPI_PREBUILT_REPOSITORY || DEFAULT_REPOSITORY;
    let artifact;
    try {
      artifact = await download(repository, key);
    } catch (error) {
      console.error(`napi-prebuilt: ${error.message}; building`);
      return false;
    }
    if (!artifact) {
      console.error(`napi-prebuilt: no prebuilt addons for ${key}; building`);
      return false;
    }
    try {
      // Check every file before replacing any, so a bad artifact changes nothing.
      const pending = [];
      for (const name of PACKAGES) {
        if (installed(name, key)) continue;
        const file = `${name}/${BINARY}`;
        const binary = readFileSync(path.join(artifact.dir, file));
        if (artifact.manifest.files[file] !== sha256(binary)) {
          console.error(
            `napi-prebuilt: ${file} does not match the artifact manifest; building`,
          );
          return false;
        }
        pending.push({ name, binary });
      }
      for (const { name, binary } of pending) {
        const target = path.join(rustDir, name, BINARY);
        // Rename over the old file: a running backend keeps the inode it mapped.
        writeFileSync(`${target}.tmp`, binary);
        renameSync(`${target}.tmp`, target);
        writeFileSync(
          path.join(rustDir, name, STAMP),
          `${key} ${sha256(binary)}\n`,
        );
      }
      const written = pending.map(({ name }) => name).join(", ");
      console.error(`napi-prebuilt: installed ${written} for ${key}`);
    } catch (error) {
      console.error(`napi-prebuilt: ${error.message}; building`);
      return false;
    } finally {
      rmSync(artifact.dir, { recursive: true, force: true });
    }
    return true;
  } finally {
    release();
  }
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
  // The blob gets five minutes: the layer is about 20 MB.
  const get = async (url, accept, timeout = 30_000) => {
    const headers = { accept };
    if (token) headers.authorization = `Bearer ${token}`;
    let response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeout),
    });
    if (response.status === 401 && !token) {
      token = await anonymousToken(
        response.headers.get("www-authenticate"),
        name,
      );
      headers.authorization = `Bearer ${token}`;
      response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(timeout),
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
  response = await get(`${base}/blobs/${layer.digest}`, "*/*", 300_000);
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

function compareVersions(a, b) {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * A directory as a lock across processes. A lock whose holder has exited is
 * taken over; a live holder is waited for at most five minutes.
 */
async function acquireLock() {
  const lock = path.join(rustDir, LOCK);
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(path.join(lock, "pid"), `${process.pid}\n`);
      return () => rmSync(lock, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    if (!holderAlive(lock) || Date.now() > deadline) {
      rmSync(lock, { recursive: true, force: true });
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function holderAlive(lock) {
  let pid;
  try {
    pid = Number(readFileSync(path.join(lock, "pid"), "utf8"));
  } catch {
    // Just created and the pid not written yet, or already released.
    return existsSync(lock) && Date.now() - statSync(lock).mtimeMs < 10_000;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
