import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  type LintMigrationResult,
  lintMigrationFile,
  summarizeIssues,
} from "@drizzle-migration-linter";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "src/database/migrations");
const GIT_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
  cwd: process.cwd(),
}).trim();

function main(): void {
  const baseRef =
    process.env.ARCHESTRA_MIGRATION_LINTER_BASE_REF ?? "origin/main";
  const files = getChangedMigrationFiles(baseRef);
  const results = files.map((file) => lintMigrationFile(file));
  const summary = summarizeIssues(results);

  printResults(results, summary, baseRef);

  if (summary.errors > 0) {
    process.exit(1);
  }
}

function getChangedMigrationFiles(baseRef: string): string[] {
  const resolvedBaseRef = ensureGitRefAvailable(baseRef);
  const migrationsPathspec = path.relative(GIT_ROOT, MIGRATIONS_DIR);
  const changedOutput = execFileSync(
    "git",
    [
      "diff",
      "--name-only",
      "--diff-filter=ACMR",
      resolvedBaseRef,
      "--",
      migrationsPathspec,
    ],
    { encoding: "utf8", cwd: GIT_ROOT },
  );
  const untrackedOutput = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "--", migrationsPathspec],
    { encoding: "utf8", cwd: GIT_ROOT },
  );

  return `${changedOutput}\n${untrackedOutput}`
    .split("\n")
    .map((file) => file.trim())
    .filter((file) => file.endsWith(".sql"))
    .filter((file) => !file.includes("/meta/"))
    .map((file) => path.resolve(GIT_ROOT, file))
    .filter((file, index, files) => files.indexOf(file) === index)
    .sort();
}

function printResults(
  results: LintMigrationResult[],
  summary: { errors: number; warnings: number },
  baseRef: string,
): void {
  if (results.length === 0) {
    process.stdout.write(
      `No changed Drizzle migration files to lint relative to ${baseRef}.\n`,
    );
    return;
  }

  for (const result of results) {
    for (const issue of result.issues) {
      const location = issue.line
        ? `${result.filePath}:${issue.line}`
        : result.filePath;
      process.stdout.write(
        `${issue.severity.toUpperCase()} ${issue.code} ${location}\n`,
      );
      process.stdout.write(`  ${issue.message}\n`);
      if (issue.statement) {
        process.stdout.write(`  SQL: ${issue.statement}\n`);
      }
    }
  }

  if (summary.errors === 0 && summary.warnings === 0) {
    process.stdout.write(
      `Drizzle migration linter passed (${results.length} changed file${results.length === 1 ? "" : "s"} checked).\n`,
    );
    return;
  }

  process.stdout.write(
    `Drizzle migration linter found ${summary.errors} error${summary.errors === 1 ? "" : "s"} and ${summary.warnings} warning${summary.warnings === 1 ? "" : "s"}.\n`,
  );
}

function ensureGitRefAvailable(baseRef: string): string {
  if (canResolveGitRef(baseRef)) {
    return baseRef;
  }

  const remoteRef = parseRemoteRef(baseRef);
  if (remoteRef) {
    const { remote, branch } = remoteRef;
    process.stderr.write(
      `Drizzle migration linter base ref ${baseRef} is not available locally; fetching ${remote} ${branch}.\n`,
    );
    execFileSync(
      "git",
      [
        "fetch",
        "--depth=1",
        remote,
        `${branch}:refs/remotes/${remote}/${branch}`,
      ],
      { cwd: GIT_ROOT, stdio: "inherit" },
    );
    return baseRef;
  }

  const originRef = `origin/${baseRef}`;
  process.stderr.write(
    `Drizzle migration linter base ref ${baseRef} is not available locally; fetching origin ${baseRef}.\n`,
  );
  execFileSync(
    "git",
    [
      "fetch",
      "--depth=1",
      "origin",
      `${baseRef}:refs/remotes/origin/${baseRef}`,
    ],
    { cwd: GIT_ROOT, stdio: "inherit" },
  );
  return originRef;
}

function canResolveGitRef(ref: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd: GIT_ROOT,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function parseRemoteRef(
  ref: string,
): { remote: string; branch: string } | null {
  const [remote, ...branchParts] = ref.split("/");
  if (!remote || branchParts.length === 0) return null;
  return { remote, branch: branchParts.join("/") };
}

main();
