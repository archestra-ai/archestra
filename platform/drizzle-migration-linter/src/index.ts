import fs from "node:fs";
import path from "node:path";

export type LintSeverity = "error" | "warning";

export type MigrationLintIssue = {
  code: string;
  severity: LintSeverity;
  message: string;
  statement: string;
  filePath?: string;
  line?: number;
};

export type LintMigrationOptions = {
  filePath?: string;
};

export type LintMigrationResult = {
  filePath?: string;
  issues: MigrationLintIssue[];
};

type Rule = {
  code: string;
  severity: LintSeverity;
  message: string;
  matches: (statement: string) => boolean;
};

const ALLOW_BREAKING_PATTERN =
  /--\s*drizzle-migration-linter:\s*allow-breaking\b/i;
const ALLOW_BREAKING_REASON_PATTERN =
  /--\s*drizzle-migration-linter:\s*reason\s*=\s*(?<reason>.+)\s*$/im;

export function lintMigrationSql(
  sql: string,
  options: LintMigrationOptions = {},
): LintMigrationResult {
  const allowBreaking = hasAllowBreakingMarker(sql);
  const issues: MigrationLintIssue[] = [];

  if (allowBreaking && !hasAllowBreakingReason(sql)) {
    issues.push({
      code: "allow-breaking-missing-reason",
      severity: "error",
      message:
        "allow-breaking marker requires `-- drizzle-migration-linter: reason=...`.",
      statement: "",
      filePath: options.filePath,
      line: findAllowBreakingMarkerLine(sql),
    });
  }

  for (const statement of splitStatements(sql)) {
    const normalizedStatement = normalizeSql(stripSqlComments(statement));
    if (!normalizedStatement) continue;

    for (const rule of RULES) {
      if (!rule.matches(normalizedStatement)) continue;
      if (allowBreaking && rule.severity === "error") continue;

      issues.push({
        code: rule.code,
        severity: rule.severity,
        message: rule.message,
        statement: statement.trim(),
        filePath: options.filePath,
        line: getLineForStatement(sql, statement),
      });
    }
  }

  return { filePath: options.filePath, issues };
}

export function lintMigrationFile(filePath: string): LintMigrationResult {
  return lintMigrationSql(fs.readFileSync(filePath, "utf8"), { filePath });
}

export function findMigrationFiles(migrationsDir: string): string[] {
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory does not exist: ${migrationsDir}`);
  }

  return fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .map((file) => path.join(migrationsDir, file))
    .sort();
}

export function summarizeIssues(results: LintMigrationResult[]): {
  errors: number;
  warnings: number;
} {
  let errors = 0;
  let warnings = 0;

  for (const result of results) {
    for (const issue of result.issues) {
      if (issue.severity === "error") errors += 1;
      else warnings += 1;
    }
  }

  return { errors, warnings };
}

// ============================================================
// Internal implementation
// ============================================================

const RULES: Rule[] = [
  {
    code: "drop-table",
    severity: "error",
    message:
      "DROP TABLE is not rollout-safe. Use an expand/contract release and drop only after old code is gone.",
    matches: (statement) => /\bDROP\s+TABLE\b/i.test(statement),
  },
  {
    code: "drop-column",
    severity: "error",
    message:
      "DROP COLUMN is not rollout-safe. Keep the old column until every supported app version no longer reads it.",
    matches: (statement) =>
      /\bALTER\s+TABLE\b[\s\S]*\bDROP\s+COLUMN\b/i.test(statement),
  },
  {
    code: "rename-table-or-column",
    severity: "error",
    message:
      "Renames are not rollout-safe. Add the new name, dual-read/write, backfill, then remove the old name later.",
    matches: (statement) =>
      /\bALTER\s+TABLE\b[\s\S]*\bRENAME(?:\s+COLUMN)?\b/i.test(statement),
  },
  {
    code: "set-not-null",
    severity: "error",
    message:
      "SET NOT NULL can fail existing data and break older writers. Backfill and enforce in a later contract release.",
    matches: (statement) =>
      /\bALTER\s+TABLE\b[\s\S]*\bALTER\s+COLUMN\b[\s\S]*\bSET\s+NOT\s+NULL\b/i.test(
        statement,
      ),
  },
  {
    code: "alter-column-type",
    severity: "error",
    message:
      "ALTER COLUMN TYPE can rewrite data and break older code. Add a new compatible column and migrate in phases.",
    matches: (statement) =>
      /\bALTER\s+TABLE\b[\s\S]*\bALTER\s+COLUMN\b[\s\S]*\bTYPE\b/i.test(
        statement,
      ),
  },
  {
    code: "add-required-column-without-default",
    severity: "error",
    message:
      "Adding a NOT NULL column without a DEFAULT is not compatible with existing rows or older writers.",
    matches: (statement) =>
      /\bALTER\s+TABLE\b[\s\S]*\bADD\s+COLUMN\b[\s\S]*\bNOT\s+NULL\b/i.test(
        statement,
      ) && !/\bDEFAULT\b/i.test(statement),
  },
  {
    code: "drop-constraint",
    severity: "error",
    message:
      "DROP CONSTRAINT changes database guarantees during rollout. Treat it as a contract migration.",
    matches: (statement) =>
      /\bALTER\s+TABLE\b[\s\S]*\bDROP\s+CONSTRAINT\b/i.test(statement),
  },
  {
    code: "add-unique-constraint",
    severity: "error",
    message:
      "Adding uniqueness can fail existing data and break older writers. Dedupe first and contract later.",
    matches: (statement) =>
      /\bADD\s+CONSTRAINT\b[\s\S]*\bUNIQUE\b/i.test(statement) ||
      /\bCREATE\s+UNIQUE\s+INDEX\b/i.test(statement),
  },
  {
    code: "add-validating-constraint",
    severity: "error",
    message:
      "Adding a validating constraint can fail existing rows. Add it NOT VALID first, then validate separately.",
    matches: (statement) =>
      /\bALTER\s+TABLE\b[\s\S]*\bADD\s+CONSTRAINT\b/i.test(statement) &&
      !/\bNOT\s+VALID\b/i.test(statement),
  },
  {
    code: "drop-index",
    severity: "error",
    message:
      "DROP INDEX can remove performance or uniqueness guarantees needed by running code. Treat it as contract work.",
    matches: (statement) => /\bDROP\s+INDEX\b/i.test(statement),
  },
  {
    code: "drop-type",
    severity: "error",
    message:
      "DROP TYPE is not rollout-safe while older code may still reference the type.",
    matches: (statement) => /\bDROP\s+TYPE\b/i.test(statement),
  },
  {
    code: "rename-type",
    severity: "error",
    message:
      "ALTER TYPE RENAME is not rollout-safe while older code may still reference the old type name.",
    matches: (statement) =>
      /\bALTER\s+TYPE\b[\s\S]*\bRENAME\b/i.test(statement),
  },
  {
    code: "cascade",
    severity: "warning",
    message:
      "CASCADE can remove dependent objects unexpectedly. Confirm this is intentional.",
    matches: (statement) => /\bCASCADE\b/i.test(statement),
  },
  {
    code: "create-index-without-concurrently",
    severity: "warning",
    message:
      "CREATE INDEX without CONCURRENTLY can block writes on large existing tables.",
    matches: (statement) =>
      /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(statement) &&
      !/\bCONCURRENTLY\b/i.test(statement),
  },
  {
    code: "unbounded-delete",
    severity: "warning",
    message:
      "DELETE without WHERE can remove all rows. Confirm this is intentional.",
    matches: (statement) =>
      /^\s*DELETE\s+FROM\b/i.test(statement) && !/\bWHERE\b/i.test(statement),
  },
  {
    code: "unbounded-update",
    severity: "warning",
    message:
      "UPDATE without WHERE can rewrite every row. Prefer bounded or idempotent backfills for large tables.",
    matches: (statement) =>
      /^\s*UPDATE\b/i.test(statement) && !/\bWHERE\b/i.test(statement),
  },
];

function splitStatements(sql: string): string[] {
  return sql
    .split(/-->\s*statement-breakpoint|;/i)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--.*$/gm, " ");
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function hasAllowBreakingMarker(sql: string): boolean {
  return ALLOW_BREAKING_PATTERN.test(sql);
}

function hasAllowBreakingReason(sql: string): boolean {
  const reason = sql.match(ALLOW_BREAKING_REASON_PATTERN)?.groups?.reason;
  return typeof reason === "string" && reason.trim().length > 0;
}

function getLineForStatement(sql: string, statement: string): number {
  const index = sql.indexOf(statement);
  if (index < 0) return 1;
  return sql.slice(0, index).split("\n").length;
}

function findAllowBreakingMarkerLine(sql: string): number {
  const match = sql.match(ALLOW_BREAKING_PATTERN);
  if (!match || match.index === undefined) return 1;
  return sql.slice(0, match.index).split("\n").length;
}
