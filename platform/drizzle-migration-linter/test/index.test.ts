import { describe, expect, test } from "vitest";
import { lintMigrationSql, summarizeIssues } from "../src";

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
