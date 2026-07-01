import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const CLI_PATH = path.resolve(import.meta.dirname, "../src/cli.ts");
const PLATFORM_ROOT = path.resolve(import.meta.dirname, "../..");
const TSX_BIN = path.join(PLATFORM_ROOT, "node_modules/.bin/tsx");

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "drizzle-linter-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("cli", () => {
  test("fails when an explicit migration file has rollout-unsafe SQL", () => {
    const migrationPath = writeMigration(
      "0001_drop_column.sql",
      'ALTER TABLE "agents" DROP COLUMN "legacy_name";',
    );

    const result = runCli([migrationPath]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("ERROR drop-column");
    expect(result.stdout).toContain("DROP COLUMN");
  });

  test("passes when an explicit migration file is additive", () => {
    const migrationPath = writeMigration(
      "0001_add_column.sql",
      'ALTER TABLE "agents" ADD COLUMN "display_name" text;',
    );

    const result = runCli([migrationPath]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("passed");
  });

  test("returns json output for automation", () => {
    const migrationPath = writeMigration(
      "0001_drop_column.sql",
      'ALTER TABLE "agents" DROP COLUMN "legacy_name";',
    );

    const result = runCli(["--format", "json", migrationPath]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      summary: { errors: 1, warnings: 0 },
      results: [
        {
          issues: [{ code: "drop-column" }],
        },
      ],
    });
  });

  test("lints only migration files changed relative to a git base", () => {
    execFileSync("git", ["init"], { cwd: tempDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: tempDir,
    });
    execFileSync("git", ["config", "user.name", "Test User"], {
      cwd: tempDir,
    });

    const migrationsDir = path.join(tempDir, "migrations");
    fs.mkdirSync(migrationsDir, { recursive: true });
    fs.writeFileSync(
      path.join(migrationsDir, "0001_initial.sql"),
      'ALTER TABLE "agents" ADD COLUMN "display_name" text;',
    );
    execFileSync("git", ["add", "."], { cwd: tempDir });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: tempDir });
    const base = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: tempDir,
      encoding: "utf8",
    }).trim();

    fs.writeFileSync(
      path.join(migrationsDir, "0002_drop_column.sql"),
      'ALTER TABLE "agents" DROP COLUMN "legacy_name";',
    );

    const result = runCli(
      ["--migrations-dir", migrationsDir, "--changed-base", base],
      tempDir,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("0002_drop_column.sql");
    expect(result.stdout).not.toContain("0001_initial.sql");
  });

  test("rejects changed-base refs that git could interpret as options", () => {
    const migrationsDir = path.join(tempDir, "migrations");
    fs.mkdirSync(migrationsDir, { recursive: true });

    const result = runCli(
      [
        "--migrations-dir",
        migrationsDir,
        "--changed-base",
        "--upload-pack=malicious/main",
      ],
      tempDir,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid base ref");
  });
});

function writeMigration(fileName: string, sql: string): string {
  const migrationPath = path.join(tempDir, fileName);
  fs.writeFileSync(migrationPath, sql);
  return migrationPath;
}

function runCli(args: string[], cwd = tempDir) {
  return spawnSync(TSX_BIN, [CLI_PATH, ...args], {
    cwd,
    encoding: "utf8",
  });
}
