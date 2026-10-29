#!/usr/bin/env node
import path from "node:path";
import {
  findChangedMigrationFiles,
  findMigrationFiles,
  isMigrationSqlFile,
  type LintMigrationResult,
  lintMigrationFile,
  summarizeIssues,
} from "./index";

type CliOptions = {
  migrationsDir: string;
  changedBase?: string;
  allowMissingBase: boolean;
  all: boolean;
  format: "pretty" | "json";
  files: string[];
};

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const files = resolveFiles(options);
  const results = files.map((file) => lintMigrationFile(file));
  const summary = summarizeIssues(results);

  if (options.format === "json") {
    process.stdout.write(`${JSON.stringify({ summary, results }, null, 2)}\n`);
  } else {
    printPrettyResults(results, summary);
  }

  if (summary.errors > 0) {
    process.exit(1);
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    migrationsDir: process.cwd(),
    allowMissingBase: false,
    all: false,
    format: "pretty",
    files: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;

    if (arg === "--") {
      continue;
    }

    if (arg === "--migrations-dir") {
      options.migrationsDir = requireValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--changed-base") {
      options.changedBase = requireValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--allow-missing-base") {
      options.allowMissingBase = true;
      continue;
    }

    if (arg === "--all") {
      options.all = true;
      continue;
    }

    if (arg === "--format") {
      const format = requireValue(args, index, arg);
      if (format !== "pretty" && format !== "json") {
        throw new Error("--format must be either `pretty` or `json`.");
      }
      options.format = format;
      index += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    options.files.push(arg);
  }

  return options;
}

function resolveFiles(options: CliOptions): string[] {
  if (options.files.length > 0) {
    return options.files
      .map((file) => path.resolve(file))
      .filter(isMigrationSqlFile);
  }

  const migrationsDir = path.resolve(options.migrationsDir);
  if (options.all || !options.changedBase) {
    return findMigrationFiles(migrationsDir);
  }

  try {
    return findChangedMigrationFiles({
      migrationsDir,
      baseRef: options.changedBase,
    });
  } catch (error) {
    if (options.allowMissingBase) {
      process.stderr.write(
        `Skipping Drizzle migration linter because changed base ${options.changedBase} is not available.\n`,
      );
      return [];
    }
    throw error;
  }
}

function printPrettyResults(
  results: LintMigrationResult[],
  summary: { errors: number; warnings: number },
): void {
  if (results.length === 0) {
    process.stdout.write("No Drizzle migration files to lint.\n");
    return;
  }

  for (const result of results) {
    for (const issue of result.issues) {
      process.stdout.write(
        `${issue.severity.toUpperCase()} ${issue.code} ${formatLocation(issue)}\n`,
      );
      process.stdout.write(`  ${issue.message}\n`);
      if (issue.statement) {
        process.stdout.write(`  SQL: ${issue.statement}\n`);
      }
    }
  }

  if (summary.errors === 0 && summary.warnings === 0) {
    process.stdout.write(
      `Drizzle migration linter passed (${results.length} file${results.length === 1 ? "" : "s"} checked).\n`,
    );
    return;
  }

  process.stdout.write(
    `Drizzle migration linter found ${summary.errors} error${summary.errors === 1 ? "" : "s"} and ${summary.warnings} warning${summary.warnings === 1 ? "" : "s"}.\n`,
  );
}

function printHelp(): void {
  process.stdout.write(`Usage: drizzle-migration-linter [options] [files...]

Options:
  --migrations-dir <dir>      Directory containing Drizzle .sql migrations.
  --changed-base <ref>        Lint migration files changed relative to a git ref.
  --allow-missing-base        Skip linting if --changed-base is unavailable.
  --all                       Lint every .sql file in --migrations-dir.
  --format <pretty|json>      Output format. Defaults to pretty.
  -h, --help                  Show this help text.

Override contract-migration errors in rare reviewed cases:
  -- drizzle-migration-linter: allow-breaking
  -- drizzle-migration-linter: reason=why this is safe now
`);
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function formatLocation(issue: { filePath?: string; line?: number }): string {
  const filePath = issue.filePath ?? "(inline SQL)";
  if (!issue.line) return filePath;
  return `${filePath}:${issue.line}`;
}

main();
