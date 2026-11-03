#!/usr/bin/env node
// Prebuilt frontends for the dev stack.
//
// A cold production build of the frontend holds about 3.5 GiB, most of a
// 4 GiB Agent Runtime. CI builds the frontend the way `scripts/dev-lite.sh`
// builds it in an Agent Runtime, for every main commit that changes its
// inputs, and publishes two OCI artifacts in the public registry: the
// standalone server (`<key>`, about 40 MB) and the build's Turbopack cache
// (`cache-<key>`, about 420 MB). A dev stack on a clean checkout whose key is
// published installs the server instead of building it. Before a build (an
// edited frontend, or a commit CI has not published yet) it seeds an empty
// build cache from the newest published commit with the same configuration,
// and the build starts warm. A cache from a commit with another Next
// configuration or platform version is worth nothing: Turbopack drops it.
//
// dev-lite.sh runs this script in the build's environment (`frontend_prebuilt`),
// because the key covers what the build reads from it:
//
//   node scripts/frontend-prebuilt.mjs --key [--explain]  print the key
//   node scripts/frontend-prebuilt.mjs --pack <dir>       CI: collect the artifacts
//   node scripts/frontend-prebuilt.mjs install            the standalone server
//   node scripts/frontend-prebuilt.mjs install-cache      the build cache
//
// Both installs exit 0 when they put the artifact in place and 1 when the
// caller builds without it: a changed tree, nothing published, a network
// error, another platform, or ARCHESTRA_DEV_FRONTEND_PREBUILT=false.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_REPOSITORY =
  "europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/frontend-dev-cache";
const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
// What a build cache stays valid across: Turbopack drops the whole cache when
// the dependencies, the Next configuration or the version it inlines change.
const CONFIG_PATHS = [
  "platform/pnpm-lock.yaml",
  "platform/pnpm-workspace.yaml",
  "platform/package.json",
  "platform/patches",
  "platform/frontend/package.json",
  "platform/frontend/next.config.ts",
  "platform/frontend/tsconfig.json",
  "platform/shared/package.json",
];
// Everything else the build reads, and the recipe that publishes it.
const SOURCE_PATHS = ["platform/frontend", "platform/shared"];
const RECIPE_PATHS = [
  "platform/scripts/frontend-prebuilt.mjs",
  ".github/workflows/frontend-dev-cache.yml",
];
// The dev-lite.sh functions that run the build, read at each commit.
const RECIPE_FUNCTIONS = [
  "frontend_build_env",
  "frontend_build_node",
  "build_frontend",
];
// Where the build environment reaches the output: Next inlines every
// NEXT_PUBLIC_ variable, and next.config.ts and the shared modules it loads
// read these. CI only quiets a plugin's build log.
const CONFIG_ENV_SOURCES = [
  "platform/frontend/next.config.ts",
  "platform/shared",
];
const IGNORED_ENV = new Set(["CI"]);
// Next loads these from the frontend directory into a production build; one
// that git does not track is a local change no tree id shows.
const FRONTEND_DOTENV = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.production.local",
];
// How far back install-cache looks for a commit with the same configuration.
const CACHE_SEARCH_DEPTH = 30;
const STAMP = ".frontend-prebuilt";

const repoDir = fileURLToPath(new URL("../../", import.meta.url));
const nextDir = path.join(repoDir, "platform", "frontend", ".next");

try {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "--key") {
    if (rest.includes("--explain"))
      console.error(environmentLines().join("\n"));
    console.log(cacheKey("HEAD"));
  } else if (command === "--pack") {
    pack(rest[0]);
  } else if (command === "install") {
    process.exitCode = (await install()) ? 0 : 1;
  } else if (command === "install-cache") {
    process.exitCode = (await installCache()) ? 0 : 1;
  } else {
    throw new Error(
      "usage: --key [--explain] | --pack <dir> | install | install-cache",
    );
  }
} catch (error) {
  console.error(`frontend-prebuilt: ${error.message}`);
  process.exitCode = 1;
}

/**
 * The trees of everything the build reads at `ref`, the recipe that builds and
 * publishes it, and the build environment this process runs in.
 */
function cacheKey(ref) {
  const paths = [...SOURCE_PATHS, ...CONFIG_PATHS, ...RECIPE_PATHS];
  return sha256(
    [
      "frontend-prebuilt 1",
      ...objectIds(paths.map((relative) => `${ref}:${relative}`)),
      sha256(recipeText(ref)),
      ...environmentLines(),
    ].join("\n"),
  );
}

/** The configuration part of a key: a build cache is reused only between equal ones. */
function configId(ref) {
  return objectIds(CONFIG_PATHS.map((relative) => `${ref}:${relative}`)).join(
    ",",
  );
}

/** Object IDs of `rev:path` names, in one git call; `missing` for an absent path. */
function objectIds(names) {
  return execFileSync(
    "git",
    ["-C", repoDir, "cat-file", "--batch-check=%(objectname)"],
    {
      input: `${names.join("\n")}\n`,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    },
  )
    .trim()
    .split("\n")
    .map((line) => (line.endsWith(" missing") ? "missing" : line));
}

/** The build functions of dev-lite.sh at `ref`, or in the working tree when null. */
function recipeText(ref) {
  const script =
    ref === null
      ? readFileSync(
          path.join(repoDir, "platform", "scripts", "dev-lite.sh"),
          "utf8",
        )
      : git("show", `${ref}:platform/scripts/dev-lite.sh`);
  return RECIPE_FUNCTIONS.map((name) => {
    const match = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, "m").exec(
      script,
    );
    if (!match) throw new Error(`dev-lite.sh at ${ref} has no ${name}()`);
    return match[0];
  }).join("\n");
}

/** The variables of this process that can change the build's output. */
function environmentLines() {
  const names = new Set(
    Object.keys(process.env).filter((name) => name.startsWith("NEXT_PUBLIC_")),
  );
  for (const file of typeScriptFiles(CONFIG_ENV_SOURCES)) {
    for (const match of readFileSync(file, "utf8").matchAll(
      /process\.env\??\.([A-Z][A-Z0-9_]*)/g,
    )) {
      names.add(match[1]);
    }
  }
  return [
    `node ${process.versions.node.split(".")[0]}`,
    ...[...names]
      .filter((name) => !IGNORED_ENV.has(name))
      .sort()
      .map((name) => `${name}=${process.env[name] ?? "(unset)"}`),
  ];
}

/** The non-test TypeScript files at these repository paths. */
function typeScriptFiles(relatives) {
  const files = [];
  const visit = (file, isDirectory) => {
    if (isDirectory) {
      for (const entry of readdirSync(file, { withFileTypes: true })) {
        if (entry.name !== "node_modules")
          visit(path.join(file, entry.name), entry.isDirectory());
      }
    } else if (/\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file)) {
      files.push(file);
    }
  };
  for (const relative of relatives) {
    const file = path.join(repoDir, relative);
    if (existsSync(file)) visit(file, !path.extname(file));
  }
  return files;
}

/**
 * Why the working tree does not build what the key of HEAD names, or "" when
 * it does.
 */
function localChanges() {
  const paths = [...SOURCE_PATHS, ...CONFIG_PATHS, ...RECIPE_PATHS].filter(
    (relative) => existsSync(path.join(repoDir, relative)),
  );
  if (git("status", "--porcelain", "--untracked-files=all", "--", ...paths)) {
    return "the frontend's inputs have local changes";
  }
  if (recipeText(null) !== recipeText("HEAD")) {
    return "dev-lite.sh's frontend build has local changes";
  }
  const dotenv = FRONTEND_DOTENV.map((name) => `platform/frontend/${name}`).find(
    (relative) =>
      existsSync(path.join(repoDir, relative)) &&
      git("ls-files", "--", relative) === "",
  );
  return dotenv ? `${dotenv} is not in git` : "";
}

function git(...args) {
  return execFileSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 << 20,
  }).trimEnd();
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** CI: `<dir>/build` and `<dir>/cache`, each published as one artifact. */
function pack(outDir) {
  if (!outDir) throw new Error("usage: --pack <dir>");
  const changes = localChanges();
  if (changes) throw new Error(changes);
  const key = cacheKey("HEAD");
  const commit = git("rev-parse", "HEAD");
  for (const [kind, source] of [
    ["build", "standalone"],
    ["cache", "cache"],
  ]) {
    if (!existsSync(path.join(nextDir, source))) {
      throw new Error(`no .next/${source}: build the frontend first`);
    }
    const dir = path.join(outDir, kind);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    execFileSync("cp", ["-a", path.join(nextDir, source), dir]);
    // The public files (about 80 MB of images) are in every checkout.
    rmSync(path.join(dir, "standalone", "frontend", "public"), {
      recursive: true,
      force: true,
    });
    const manifest = { key, kind, commit, config: configId("HEAD") };
    writeFileSync(
      path.join(dir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }
  console.log(key);
}

/** The standalone server CI built for this clean checkout, when published. */
async function install() {
  const stamp = path.join(nextDir, STAMP);
  const installed = existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : "";
  // Unless this returns true a build follows, and the stamp must not vouch
  // for its output.
  rmSync(stamp, { force: true });
  if (!usable()) return false;
  const changes = localChanges();
  if (changes) {
    console.error(`frontend-prebuilt: ${changes}; building`);
    return false;
  }
  const key = cacheKey("HEAD");
  if (
    installed === key &&
    existsSync(path.join(nextDir, "standalone", "frontend", "server.js"))
  ) {
    writeFileSync(stamp, `${key}\n`);
    return true;
  }
  const artifact = await fetchArtifact(key, "build");
  if (!artifact) return false;
  try {
    rmSync(path.join(nextDir, "standalone"), { recursive: true, force: true });
    renameSync(
      path.join(artifact.dir, "standalone"),
      path.join(nextDir, "standalone"),
    );
    execFileSync("cp", [
      "-R",
      path.join(repoDir, "platform", "frontend", "public"),
      path.join(nextDir, "standalone", "frontend", "public"),
    ]);
    writeFileSync(stamp, `${key}\n`);
    console.error(
      `frontend-prebuilt: installed the frontend CI built at ${artifact.manifest.commit}`,
    );
    return true;
  } finally {
    rmSync(artifact.dir, { recursive: true, force: true });
  }
}

/**
 * The build cache of the newest commit, among the last CACHE_SEARCH_DEPTH,
 * whose configuration equals this checkout's. Leaves an existing cache alone.
 */
async function installCache() {
  if (!usable() || existsSync(path.join(nextDir, "cache"))) return false;
  const config = configId("HEAD");
  const commits = git(
    "rev-list",
    `--max-count=${CACHE_SEARCH_DEPTH}`,
    "HEAD",
  ).split("\n");
  for (const commit of commits.filter((c) => c && configId(c) === config)) {
    let key;
    try {
      key = cacheKey(commit);
    } catch {
      continue;
    }
    const artifact = await fetchArtifact(key, "cache", { quiet: true });
    if (!artifact) continue;
    try {
      renameSync(path.join(artifact.dir, "cache"), path.join(nextDir, "cache"));
      console.error(
        `frontend-prebuilt: seeded the build cache from ${commit.slice(0, 10)}`,
      );
      return true;
    } finally {
      rmSync(artifact.dir, { recursive: true, force: true });
    }
  }
  console.error(
    "frontend-prebuilt: no build cache published for this configuration",
  );
  return false;
}

function usable() {
  if (process.env.ARCHESTRA_DEV_FRONTEND_PREBUILT === "false") return false;
  return process.platform === "linux" && process.arch === "x64";
}

/**
 * Download and unpack one artifact under .next, on the workspace's disk (/tmp
 * may be memory). Null when it is not published or does not check out.
 */
async function fetchArtifact(key, kind, { quiet = false } = {}) {
  const repository =
    process.env.ARCHESTRA_DEV_FRONTEND_PREBUILT_REPOSITORY ||
    DEFAULT_REPOSITORY;
  const tag = kind === "cache" ? `cache-${key}` : key;
  const dir = path.join(nextDir, `.frontend-prebuilt-${kind}`);
  rmSync(dir, { recursive: true, force: true });
  try {
    mkdirSync(dir, { recursive: true });
    const layer = path.join(dir, "layer.tar.gz");
    if (!(await downloadLayer(repository, tag, layer))) {
      if (!quiet)
        console.error(
          `frontend-prebuilt: nothing published for ${tag}; building`,
        );
      rmSync(dir, { recursive: true, force: true });
      return null;
    }
    execFileSync("tar", ["-xzf", layer, "-C", dir], { stdio: "ignore" });
    rmSync(layer);
    const manifest = JSON.parse(
      readFileSync(path.join(dir, "manifest.json"), "utf8"),
    );
    if (manifest.key !== key || manifest.kind !== kind) {
      throw new Error(`${tag} holds another artifact`);
    }
    return { dir, manifest };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    console.error(`frontend-prebuilt: ${error.message}; building without it`);
    return null;
  }
}

/** Stream the artifact's single layer to `file`; false when the tag does not exist. */
async function downloadLayer(repository, tag, file) {
  // `host/name`, or a URL with a scheme for a local test registry.
  const url = new URL(
    /^https?:\/\//.test(repository) ? repository : `https://${repository}`,
  );
  const name = url.pathname.replace(/^\/+|\/+$/g, "");
  const base = `${url.origin}/v2/${name}`;
  let token;
  const get = async (target, accept, timeout = 30_000) => {
    const headers = { accept };
    if (token) headers.authorization = `Bearer ${token}`;
    let response = await fetch(target, {
      headers,
      signal: AbortSignal.timeout(timeout),
    });
    if (response.status === 401 && !token) {
      token = await anonymousToken(
        response.headers.get("www-authenticate"),
        name,
      );
      headers.authorization = `Bearer ${token}`;
      response = await fetch(target, {
        headers,
        signal: AbortSignal.timeout(timeout),
      });
    }
    return response;
  };
  let response = await get(`${base}/manifests/${tag}`, MANIFEST_TYPES);
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`registry answered ${response.status}`);
  let manifest = await response.json();
  if (manifest.manifests) {
    const entry = manifest.manifests.find(
      (m) => m.platform?.os === "linux" && m.platform?.architecture === "amd64",
    );
    if (!entry) throw new Error(`${tag} has no linux/amd64 manifest`);
    response = await get(`${base}/manifests/${entry.digest}`, MANIFEST_TYPES);
    if (!response.ok) throw new Error(`registry answered ${response.status}`);
    manifest = await response.json();
  }
  if (manifest.layers?.length !== 1)
    throw new Error(`${tag} has an unexpected layout`);
  const layer = manifest.layers[0];
  // The cache layer is about 420 MB: stream it to disk, never hold it.
  response = await get(`${base}/blobs/${layer.digest}`, "*/*", 900_000);
  if (!response.ok || !response.body)
    throw new Error(`registry answered ${response.status}`);
  const hash = createHash("sha256");
  await pipeline(
    Readable.fromWeb(response.body),
    new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    }),
    createWriteStream(file),
  );
  if (`sha256:${hash.digest("hex")}` !== layer.digest) {
    throw new Error(`${tag} does not match its digest`);
  }
  return true;
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
