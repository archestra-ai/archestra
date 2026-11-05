#!/usr/bin/env node
// Checks the frontend's route import boundaries:
//   1. A route's `_parts/` folder is private to that route: only files under
//      `src/app/<route>/` (the route and its child routes) import from
//      `src/app/<route>/_parts/`. Code another route needs goes in
//      `src/components/<feature>/`.
//   2. Code outside `src/app` does not import from `src/app`. A hook or helper
//      a page or layout exports for others belongs in `_parts/` or
//      `src/components/`.
// Conventions: platform/frontend/AGENTS.md, "Conventions".
//
// Usage: node scripts/check-route-imports.mjs [srcDir]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontendDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const srcDir = path.resolve(process.argv[2] ?? path.join(frontendDir, "src"));
const appDir = path.join(srcDir, "app");

// "importer -> imported", both relative to src. Each needs a reason.
const ALLOWED = new Map([
  [
    "app/_parts/sidebar.tsx -> app/agents/_parts/preload.ts",
    "preloads the Agents page's own chunk, so it has to live beside that page",
  ],
  [
    "lib/request-origin.test.ts -> app/connect.md/route.ts",
    "checks that the route handlers derive their origin through this helper",
  ],
  [
    "lib/request-origin.test.ts -> app/llms.txt/route.ts",
    "checks that the route handlers derive their origin through this helper",
  ],
]);

const SPECIFIER =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\bmock\(\s*|\brequire\(\s*)(["'])((?:@\/|\.\.?\/)[^"']+)\1/g;
const EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".css"];

const violations = [];
const seenAllowed = new Set();
for (const file of walk(srcDir)) {
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(SPECIFIER)) {
    const target = resolve(file, match[2]);
    if (!target || !target.startsWith(appDir + path.sep)) continue;
    const problem = breaksBoundary(file, target);
    if (!problem) continue;
    const key = `${rel(file)} -> ${rel(target)}`;
    if (ALLOWED.has(key)) {
      seenAllowed.add(key);
      continue;
    }
    violations.push(`${key}\n    ${problem}`);
  }
}
const staleAllowed = [...ALLOWED.keys()].filter((key) => !seenAllowed.has(key));

if (violations.length > 0 || staleAllowed.length > 0) {
  if (violations.length > 0) {
    console.error(
      `${violations.length} import(s) cross a route boundary:\n  ${[
        ...new Set(violations),
      ].join("\n  ")}`,
    );
    console.error(
      "Move the imported file to `src/components/<feature>/` when another route or shared code needs it. See platform/frontend/AGENTS.md, Conventions.",
    );
  }
  if (staleAllowed.length > 0) {
    console.error(
      `Allowed imports that no longer exist; remove them from ALLOWED in scripts/check-route-imports.mjs:\n  ${staleAllowed.join("\n  ")}`,
    );
  }
  process.exit(1);
}
console.log("Route import boundaries hold.");

// ===== Internal helpers =====

/** Why importing `target` from `importer` breaks a boundary, or null. */
function breaksBoundary(importer, target) {
  if (!importer.startsWith(appDir + path.sep)) {
    return "code outside src/app imports from src/app";
  }
  const segments = path.relative(appDir, target).split(path.sep);
  const privateIndex = segments.findIndex(
    (segment, index) => index < segments.length - 1 && segment.startsWith("_"),
  );
  if (privateIndex === -1) return null;
  const owner = path.join(appDir, ...segments.slice(0, privateIndex));
  if (importer.startsWith(owner + path.sep)) return null;
  return `\`${path.relative(srcDir, owner) || "app"}\`'s private folder is imported from outside that route`;
}

function resolve(fromFile, specifier) {
  const base = specifier.startsWith("@/")
    ? path.join(srcDir, specifier.slice(2))
    : path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    ...EXTENSIONS.map((extension) => base + extension),
    ...EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
  ];
  return candidates.find((candidate) => isFile(candidate)) ?? null;
}

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(entryPath);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) yield entryPath;
  }
}

function rel(file) {
  return path.relative(srcDir, file).split(path.sep).join("/");
}
