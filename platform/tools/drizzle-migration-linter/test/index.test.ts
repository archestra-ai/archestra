import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  findChangedMigrationFiles,
  findMigrationFiles,
  isMigrationSqlFile,
  lintMigrationSql,
  summarizeIssues,
} from "../src";

describe("lintMigrationSql", () => {
  test("allows additive nullable columns", () => {
    const result = lintMigrationSql(
      'ALTER TABLE "agents" ADD COLUMN "display_name" text;',
    );

    expect(result.issues).toEqual([]);
  });

  test("allows additive not-null columns with a default", () => {
    const result = lintMigrationSql(
      'ALTER TABLE "agents" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;',
    );

    expect(result.issues).toEqual([]);
  });

  test("flags dropping a column", () => {
    const result = lintMigrationSql(
      'ALTER TABLE "agents" DROP COLUMN "legacy_name";',
    );

    expect(result.issues.map((issue) => issue.code)).toContain("drop-column");
  });

  test("flags dropping a table", () => {
    const result = lintMigrationSql('DROP TABLE "old_agents" CASCADE;');

    expect(result.issues.map((issue) => issue.code)).toEqual([
      "drop-table",
      "cascade",
    ]);
  });

  test("flags renaming a column", () => {
    const result = lintMigrationSql(
      'ALTER TABLE "agents" RENAME COLUMN "name" TO "display_name";',
    );

    expect(result.issues.map((issue) => issue.code)).toContain(
      "rename-table-or-column",
    );
  });

  test("flags setting not null on an existing column", () => {
    const result = lintMigrationSql(
      'ALTER TABLE "agents" ALTER COLUMN "display_name" SET NOT NULL;',
    );

    expect(result.issues.map((issue) => issue.code)).toContain("set-not-null");
  });

  test("flags altering an existing column type", () => {
    const result = lintMigrationSql(
      'ALTER TABLE "agents" ALTER COLUMN "metadata" TYPE jsonb USING "metadata"::jsonb;',
    );

    expect(result.issues.map((issue) => issue.code)).toContain(
      "alter-column-type",
    );
  });

  test("flags adding a required column without a default", () => {
    const result = lintMigrationSql(
      'ALTER TABLE "agents" ADD COLUMN "slug" text NOT NULL;',
    );

    expect(result.issues.map((issue) => issue.code)).toContain(
      "add-required-column-without-default",
    );
  });

  test("flags unique indexes", () => {
    const result = lintMigrationSql(
      'CREATE UNIQUE INDEX "agents_slug_idx" ON "agents" ("slug");',
    );

    expect(result.issues.map((issue) => issue.code)).toEqual([
      "add-unique-constraint",
    ]);
  });

  test("flags unique table constraints without duplicate validating-constraint output", () => {
    const result = lintMigrationSql(
      'ALTER TABLE "agents" ADD CONSTRAINT "agents_slug_unique" UNIQUE("slug");',
    );

    expect(result.issues.map((issue) => issue.code)).toEqual([
      "add-unique-constraint",
    ]);
  });

  test("flags validating constraints but allows not-valid constraints", () => {
    const validating = lintMigrationSql(
      'ALTER TABLE "agents" ADD CONSTRAINT "agents_org_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id");',
    );
    const notValid = lintMigrationSql(
      'ALTER TABLE "agents" ADD CONSTRAINT "agents_org_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") NOT VALID;',
    );

    expect(validating.issues.map((issue) => issue.code)).toContain(
      "add-validating-constraint",
    );
    expect(notValid.issues).toEqual([]);
  });

  test("flags create index without concurrently as a warning", () => {
    const result = lintMigrationSql(
      'CREATE INDEX "agents_name_idx" ON "agents" ("name");',
    );

    expect(result.issues).toMatchObject([
      {
        code: "create-index-without-concurrently",
        severity: "warning",
      },
    ]);
  });

  test.each([
    [
      "drop-constraint",
      'ALTER TABLE "agents" DROP CONSTRAINT "agents_org_fk";',
    ],
    ["drop-index", 'DROP INDEX "agents_name_idx";'],
    ["drop-type", 'DROP TYPE "agent_status";'],
    ["rename-type", 'ALTER TYPE "agent_status" RENAME TO "profile_status";'],
    ["unbounded-delete", 'DELETE FROM "agents";'],
    ["unbounded-update", 'UPDATE "agents" SET "enabled" = false;'],
  ])("flags %s", (code, sql) => {
    const result = lintMigrationSql(sql);
    expect(result.issues.map((issue) => issue.code)).toContain(code);
  });

  test("attributes issues to the supplied file and statement line", () => {
    const result = lintMigrationSql(
      '\nALTER TABLE "agents" ADD COLUMN "display_name" text;\n\nDROP INDEX "agents_name_idx";',
      { filePath: "/tmp/0002_contract.sql" },
    );

    expect(result.issues).toMatchObject([
      {
        code: "drop-index",
        filePath: "/tmp/0002_contract.sql",
        line: 4,
      },
    ]);
  });

  test("allow-breaking marker suppresses contract errors but not warnings", () => {
    const result = lintMigrationSql(`
      -- drizzle-migration-linter: allow-breaking
      -- drizzle-migration-linter: reason=old column has been unused for two releases
      ALTER TABLE "agents" DROP COLUMN "legacy_name";
      CREATE INDEX "agents_name_idx" ON "agents" ("name");
    `);

    expect(result.issues).toMatchObject([
      {
        code: "create-index-without-concurrently",
        severity: "warning",
      },
    ]);
  });

  test("allow-breaking marker accepts horizontal spacing only", () => {
    const result = lintMigrationSql(`
      --\tdrizzle-migration-linter:\tallow-breaking
      -- drizzle-migration-linter:\treason\t=\told column has been unused for two releases
      ALTER TABLE "agents" DROP COLUMN "legacy_name";
    `);

    expect(result.issues).toEqual([]);
  });

  test("allow-breaking marker requires a reason", () => {
    const result = lintMigrationSql(`
      -- drizzle-migration-linter: allow-breaking
      ALTER TABLE "agents" DROP COLUMN "legacy_name";
    `);

    expect(result.issues).toMatchObject([
      {
        code: "allow-breaking-missing-reason",
        severity: "error",
      },
    ]);
  });

  test("allow-breaking reason cannot be only whitespace", () => {
    const result = lintMigrationSql(`
      -- drizzle-migration-linter: allow-breaking
      -- drizzle-migration-linter: reason=${" ".repeat(4)}
      ALTER TABLE "agents" DROP COLUMN "legacy_name";
    `);

    expect(result.issues).toMatchObject([
      {
        code: "allow-breaking-missing-reason",
        severity: "error",
      },
    ]);
  });

  test("strips malformed block comments without regex backtracking", () => {
    const result = lintMigrationSql(
      `/*${"*".repeat(20_000)}\nALTER TABLE "agents" DROP COLUMN "legacy_name";`,
    );

    expect(result.issues).toEqual([]);
  });
});

describe("summarizeIssues", () => {
  test("counts errors and warnings", () => {
    const summary = summarizeIssues([
      lintMigrationSql('DROP TABLE "old_agents";'),
      lintMigrationSql('CREATE INDEX "agents_name_idx" ON "agents" ("name");'),
    ]);

    expect(summary).toEqual({ errors: 1, warnings: 1 });
  });
});

describe("migration file discovery", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "drizzle-linter-files-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("findMigrationFiles returns only sorted SQL files", () => {
    fs.writeFileSync(path.join(tempDir, "0002_second.sql"), "SELECT 2;");
    fs.writeFileSync(path.join(tempDir, "README.md"), "not SQL");
    fs.writeFileSync(path.join(tempDir, "0001_first.sql"), "SELECT 1;");

    expect(findMigrationFiles(tempDir)).toEqual([
      path.join(tempDir, "0001_first.sql"),
      path.join(tempDir, "0002_second.sql"),
    ]);
    expect(() => findMigrationFiles(path.join(tempDir, "missing"))).toThrow(
      "Migrations directory does not exist",
    );
  });

  test("isMigrationSqlFile excludes metadata and non-SQL files", () => {
    expect(isMigrationSqlFile(path.join(tempDir, "0001.sql"))).toBe(true);
    expect(isMigrationSqlFile(path.join(tempDir, "meta", "0001.sql"))).toBe(
      false,
    );
    expect(isMigrationSqlFile(path.join(tempDir, "0001.json"))).toBe(false);
  });

  test("findChangedMigrationFiles includes changed and untracked SQL but excludes meta", () => {
    execFileSync("git", ["init"], { cwd: tempDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: tempDir,
    });
    execFileSync("git", ["config", "user.name", "Test User"], {
      cwd: tempDir,
    });
    const migrationsDir = path.join(tempDir, "migrations");
    fs.mkdirSync(path.join(migrationsDir, "meta"), { recursive: true });
    fs.writeFileSync(path.join(migrationsDir, "0001_initial.sql"), "SELECT 1;");
    execFileSync("git", ["add", "."], { cwd: tempDir });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: tempDir });
    const baseRef = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: tempDir,
      encoding: "utf8",
    }).trim();

    fs.writeFileSync(path.join(migrationsDir, "0001_initial.sql"), "SELECT 2;");
    fs.writeFileSync(path.join(migrationsDir, "0002_new.sql"), "SELECT 3;");
    fs.writeFileSync(
      path.join(migrationsDir, "meta", "snapshot.sql"),
      "SELECT 4;",
    );

    expect(
      findChangedMigrationFiles({
        migrationsDir,
        baseRef,
        options: { cwd: tempDir },
      }),
    ).toEqual([
      path.join(migrationsDir, "0001_initial.sql"),
      path.join(migrationsDir, "0002_new.sql"),
    ]);
  });
});
