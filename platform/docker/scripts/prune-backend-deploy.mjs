// Trims the backend tree that `pnpm deploy --prod` writes (Dockerfile builder
// stage) down to what the server can load at runtime.
//
// 1. Cuts optional-peer links the server never follows. better-auth and
//    drizzle-orm declare next, vitest and PGlite as optional peers, and pnpm
//    resolves those peers from the backend's dev dependencies and the
//    frontend. `pnpm deploy --prod` keeps every resolved peer, so the server
//    image used to carry Next.js with its SWC binary, Vitest (with msw, vite
//    and TypeScript behind it) and PGlite. Only store entries that become
//    unreachable from the backend's own dependencies are deleted, so a package
//    a production dependency still reaches stays.
// 2. Deletes third-party source maps and type declarations. Node never reads
//    declarations. The server keeps its own dist/*.map for when
//    ARCHESTRA_NODE_SOURCE_MAPS=true turns on --enable-source-maps; frames
//    inside dependencies print compiled line numbers.
//
// Fails, leaving the tree untouched, when the bundle in dist imports a package
// this script cuts.
//
// Usage: node prune-backend-deploy.mjs <deploy-dir>

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

const UNUSED_OPTIONAL_PEERS = ["next", "vitest", "@electric-sql/pglite"];
const STRIPPED_FILE = /\.(?:map|d\.ts|d\.mts|d\.cts)$/;

const deployDir = process.argv[2];
if (!deployDir) {
  console.error("usage: prune-backend-deploy.mjs <deploy-dir>");
  process.exit(2);
}

const nodeModules = path.join(deployDir, "node_modules");
const store = path.join(nodeModules, ".pnpm");

const importer = findBundleImport(path.join(deployDir, "dist"));
if (importer) {
  console.error(
    `${importer.file} imports ${importer.name}, which this script removes. ` +
      `Drop it from UNUSED_OPTIONAL_PEERS in ${path.basename(import.meta.filename)}.`,
  );
  process.exit(1);
}

const before = reachableStoreEntries();
let cutLinks = 0;
for (const entry of readdirSync(store)) {
  if (entry === "node_modules") continue;
  for (const name of UNUSED_OPTIONAL_PEERS) {
    const link = path.join(store, entry, "node_modules", name);
    if (isSymlink(link)) {
      unlinkSync(link);
      cutLinks++;
    }
  }
}
const after = reachableStoreEntries();

let freedBytes = 0;
let removedEntries = 0;
for (const entry of before) {
  if (after.has(entry)) continue;
  const dir = path.join(store, entry);
  freedBytes += sizeOf(dir);
  rmSync(dir, { recursive: true, force: true });
  removedEntries++;
}

// pnpm's hoisted links (.pnpm/node_modules) to removed entries now dangle.
for (const link of packageEntries(path.join(store, "node_modules"))) {
  if (isSymlink(link) && !existsSync(link)) unlinkSync(link);
}

let strippedFiles = 0;
for (const file of walkFiles(nodeModules)) {
  if (!STRIPPED_FILE.test(file) || keepsDeclarations(file)) continue;
  freedBytes += statSync(file).size;
  unlinkSync(file);
  strippedFiles++;
}

console.log(
  `prune-backend-deploy: cut ${cutLinks} optional-peer links, removed ` +
    `${removedEntries} store entries and ${strippedFiles} maps/declarations, ` +
    `freed ${(freedBytes / 1e6).toFixed(1)} MB`,
);

// === Internal helpers

/** Store entries (`.pnpm/<id>`) reachable from the top-level dependencies. */
function reachableStoreEntries() {
  const seen = new Set();
  const queue = [];
  const visit = (link) => {
    const id = storeEntryOf(link);
    if (id && !seen.has(id)) {
      seen.add(id);
      queue.push(id);
    }
  };
  for (const link of packageEntries(nodeModules)) visit(link);
  while (queue.length > 0) {
    const id = queue.pop();
    for (const link of packageEntries(path.join(store, id, "node_modules"))) {
      if (isSymlink(link)) visit(link);
    }
  }
  return seen;
}

/** `<id>` when `link` resolves into `.pnpm/<id>/`, else null. */
function storeEntryOf(link) {
  let target;
  try {
    target = realpathSync(link);
  } catch {
    return null;
  }
  const relative = path.relative(realpathSync(store), target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const id = relative.split(path.sep)[0];
  return id === "node_modules" ? null : id;
}

/** Package paths in a node_modules directory, with scopes expanded. */
function packageEntries(dir) {
  if (!existsSync(dir)) return [];
  const entries = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (name.startsWith("@") && !isSymlink(full)) {
      for (const scoped of readdirSync(full)) {
        entries.push(path.join(full, scoped));
      }
    } else {
      entries.push(full);
    }
  }
  return entries;
}

function findBundleImport(distDir) {
  if (!existsSync(distDir)) return null;
  const names = UNUSED_OPTIONAL_PEERS.map((n) => n.replace(/[/.]/g, "\\$&"));
  const specifier = new RegExp(
    `(?:\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\brequire\\s*\\(\\s*)["'](${names.join("|")})(?:/[^"']*)?["']`,
  );
  for (const file of walkFiles(distDir)) {
    if (!/\.(?:mjs|cjs|js)$/.test(file)) continue;
    const match = specifier.exec(readFileSync(file, "utf8"));
    if (match) return { file, name: match[1] };
  }
  return null;
}

function* walkFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else if (entry.isFile()) yield full;
  }
}

/** TypeScript reads its own lib.*.d.ts when something compiles at runtime. */
function keepsDeclarations(file) {
  const relative = path.relative(store, file);
  return (
    !relative.startsWith("..") &&
    relative.split(path.sep)[0].startsWith("typescript@") &&
    !file.endsWith(".map")
  );
}

function sizeOf(target) {
  const stat = lstatSync(target);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const name of readdirSync(target)) {
    total += sizeOf(path.join(target, name));
  }
  return total;
}

function isSymlink(target) {
  try {
    return lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}
