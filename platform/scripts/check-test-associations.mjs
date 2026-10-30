import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// These package-script runners predate .test naming and must stay outside the
// Vitest projects: they need a disposable real PostgreSQL database.
const runnerEntrypoints = new Set([
  "platform/backend/src/test/llm-limits/postgres.integration.ts",
  "platform/backend/src/test/agent-transcripts.postgres.ts",
]);
const testSuffix = /\.(test|spec)\.[cm]?[jt]sx?$/;
const codeSuffix = /\.(?:[cm]?[jt]sx?|sql|py|sh|ps1)$/;
const excluded =
  /(?:^|\/)(?:node_modules|vendor|generated|__generated__|dist|build|target|\.next[^/]*|\.turbo)(?:\/|$)|\.(?:gen|generated)\./;

/** Check the three application workspaces, including standalone Node tests. */
export function isTest(file) {
  return (
    /^platform\/(backend|frontend|shared)\//.test(file) &&
    !file.startsWith("platform/frontend/tests-integration/") &&
    !excluded.test(file) &&
    (testSuffix.test(file) || runnerEntrypoints.has(file))
  );
}

/** Structural ownership only: naming cannot prove what assertions exercise. */
export function inventory(files, associations = {}) {
  const tests = [...files].filter(isTest).sort();
  const testSet = new Set(tests);
  const sources = new Set([...files].filter(isSource));
  const byDirectory = new Map();
  for (const source of sources) {
    const directory = path.posix.dirname(source);
    if (!byDirectory.has(directory)) byDirectory.set(directory, []);
    byDirectory.get(directory).push(source);
  }
  const automatic = new Map(
    tests.map((test) => [test, associate(test, sources, byDirectory)]),
  );
  const errors = [];
  for (const [test, entry] of Object.entries(associations)) {
    if (!testSet.has(test))
      errors.push(`${test}: stale or out-of-scope association`);
    if (automatic.get(test))
      errors.push(`${test}: remove the redundant explicit association`);
    if (
      !entry ||
      typeof entry.reason !== "string" ||
      !entry.reason.trim() ||
      !Array.isArray(entry.targets) ||
      !entry.targets.length
    ) {
      errors.push(
        `${test}: an association needs concrete targets and a reason`,
      );
      continue;
    }
    for (const target of entry.targets) {
      if (
        typeof target !== "string" ||
        path.posix.normalize(target) !== target ||
        !files.has(target) ||
        !isOwner(target)
      ) {
        errors.push(`${test}: invalid implementation target ${target}`);
      }
    }
  }
  const rows = tests.map((test) => ({
    test,
    ...(automatic.get(test) ??
      (associations[test]
        ? { kind: "explicit", targets: associations[test].targets }
        : { kind: "unassociated", targets: [] })),
  }));
  return { rows, errors };
}

function isOwner(file) {
  if (
    testSuffix.test(file) ||
    runnerEntrypoints.has(file) ||
    excluded.test(file) ||
    /\.d\.[cm]?ts$|\.test-data\./.test(file) ||
    /(?:^|\/)(?:__tests__|__mocks__|fixtures)(?:\/|$)/.test(file) ||
    /(?:^|\/)fixtures\.[cm]?[jt]sx?$/.test(file) ||
    file.startsWith("platform/backend/src/test/mocks/") ||
    file.startsWith("platform/frontend/src/mocks/data/") ||
    file === "platform/frontend/public/mockServiceWorker.js"
  )
    return false;
  // Explicit dependency, migration and image-runner contracts may own their
  // actual patch/config/executable artifact. They never create prefix matches.
  return (
    codeSuffix.test(file) ||
    /\.(?:patch|json|ya?ml)$/.test(file) ||
    /^platform\/docker_images\/agent\/bin\/[^/.]+$/.test(file)
  );
}

function isSource(file) {
  return codeSuffix.test(file) && isOwner(file);
}

function associate(test, sources, byDirectory) {
  const stem = path.posix.basename(test).replace(testSuffix, "");
  const directory = path.posix.dirname(test);
  const ownerDirectory =
    path.posix.basename(directory) === "__tests__"
      ? path.posix.dirname(directory)
      : directory;
  const colocated = byDirectory.get(ownerDirectory) ?? [];
  const matches = colocated
    .filter((source) => {
      const name = path.posix.basename(source).replace(codeSuffix, "");
      if (hasPrefix(stem, name)) return true;
      // Preserve .ee.test, including topic segments before the enterprise marker.
      const qualified = stem.replace(/\.(unit|rollback)$/, "");
      return (
        name.endsWith(".ee") &&
        qualified.endsWith(".ee") &&
        hasPrefix(qualified.slice(0, -3), name.slice(0, -3))
      );
    })
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  if (matches.length) {
    const target = matches[0];
    return {
      kind:
        path.posix.basename(target).replace(codeSuffix, "") === stem
          ? "exact"
          : "prefix",
      targets: [target],
    };
  }
  // Both grouped entity.routes.ts and older flat entity.ts routes are active.
  const endpoint = stem.match(
    /^.+\.([^.]+)\.routes?(\.ee)?(?:\.(?:unit|rollback))?$/,
  );
  if (test.startsWith("platform/backend/") && endpoint) {
    const entity = `${ownerDirectory}/${endpoint[1]}`;
    const target = [
      `${entity}.routes${endpoint[2] ?? ""}.ts`,
      `${entity}${endpoint[2] ?? ""}.ts`,
    ].find((f) => sources.has(f));
    if (target) return { kind: "endpoint", targets: [target] };
  }
  const base = stem.replace(/\.(unit|rollback|integration)$/, "");
  const entrypoints = ["ts", "tsx", "ee.ts"].map(
    (ext) => `${ownerDirectory}/${base}/index.${ext}`,
  );
  if (base === path.posix.basename(ownerDirectory)) {
    entrypoints.push(
      ...["ts", "tsx", "ee.ts"].map((ext) => `${ownerDirectory}/index.${ext}`),
    );
  }
  const target = entrypoints.find((f) => sources.has(f));
  return target ? { kind: "entrypoint", targets: [target] } : null;
}

function hasPrefix(test, source) {
  return (
    test === source ||
    test.startsWith(`${source}.`) ||
    test.startsWith(`${source}-`)
  );
}

function main() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const files = new Set(
    execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root, encoding: "utf8" },
    )
      .split("\0")
      .filter(
        (file) =>
          file &&
          existsSync(path.join(root, file)) &&
          lstatSync(path.join(root, file)).isFile(),
      ),
  );
  const associations = JSON.parse(
    readFileSync(new URL("./test-associations.json", import.meta.url), "utf8"),
  );
  const result = inventory(files, associations);
  const missing = result.rows.filter((row) => row.kind === "unassociated");
  if (process.argv.includes("--json"))
    console.log(JSON.stringify(result, null, 2));
  else {
    for (const message of result.errors) console.error(message);
    for (const { test } of missing)
      console.error(
        `${test}: no implementation owner. Reuse an existing suite or name this test after its implementation. Cross-module contracts need concrete owners in platform/scripts/test-associations.json.`,
      );
    console.log(
      `Test associations: ${result.rows.length} tests, ${missing.length} unassociated, ${result.errors.length} registry errors.`,
    );
  }
  process.exitCode = missing.length || result.errors.length ? 1 : 0;
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
)
  main();
