import path from "node:path";
import {
  findChangedMigrationFiles,
  type LintMigrationResult,
  lintMigrationFile,
  summarizeIssues,
} from "@drizzle-migration-linter";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "src/database/migrations");

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
  return findChangedMigrationFiles({
    migrationsDir: MIGRATIONS_DIR,
    baseRef,
    options: { cwd: process.cwd() },
  });
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

main();
