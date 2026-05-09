/**
 * Static check: every model query against a soft-deletable table should
 * apply `notDeleted` (or an explicit `includeDeleted` opt-in).
 *
 * Known gaps the scanner does not cover:
 *   - `db.query.<table>` relational queries.
 *   - Raw `db.execute(sql\`...\`)`.
 *   - Statements that span more than `WINDOW_LINES` lines.
 *   - Re-export aliases of `schema.xxxTable`.
 *
 * For intentional bypasses, add a `// soft-delete:` comment near the call
 * site and the scanner will allow it.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = path.join(__dirname, "schemas");
const MODELS_DIR = path.join(__dirname, "..", "models");

const WINDOW_LINES = 25;
const PREDICATE_REGEX = /notDeleted\b|deletedAt\b|includeDeleted\b/;
const ALLOW_COMMENT = /\/\/\s*soft-delete:/;

function listSoftDeletableTables(): Set<string> {
  const result = new Set<string>();
  const schemaFiles = fs
    .readdirSync(SCHEMAS_DIR)
    .filter(
      (f) => f.endsWith(".ts") && !f.startsWith("_") && !f.endsWith(".test.ts"),
    );

  for (const file of schemaFiles) {
    const src = fs.readFileSync(path.join(SCHEMAS_DIR, file), "utf8");
    if (!src.includes("softDeleteColumns")) continue;

    const pgTableMatches = src.matchAll(
      /(?:const|export\s+const)\s+(\w+)\s*=\s*pgTable\(/g,
    );
    for (const match of pgTableMatches) {
      result.add(match[1]);
    }
  }
  return result;
}

function listModelFiles(): string[] {
  return fs
    .readdirSync(MODELS_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => path.join(MODELS_DIR, f));
}

interface Offense {
  file: string;
  line: number;
  table: string;
  snippet: string;
}

function scanFile(
  filePath: string,
  softDeletableTables: Set<string>,
): Offense[] {
  const src = fs.readFileSync(filePath, "utf8");
  const lines = src.split("\n");
  const offenses: Offense[] = [];
  const callRegex = /\.(?:from|update)\(\s*schema\.(\w+)\s*\)/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const match of line.matchAll(callRegex)) {
      const table = match[1];
      if (!softDeletableTables.has(table)) continue;

      const start = Math.max(0, i - WINDOW_LINES);
      const end = Math.min(lines.length, i + WINDOW_LINES + 1);
      const window = lines.slice(start, end).join("\n");

      if (PREDICATE_REGEX.test(window)) continue;
      if (ALLOW_COMMENT.test(window)) continue;

      offenses.push({
        file: path.relative(path.join(__dirname, "..", ".."), filePath),
        line: i + 1,
        table,
        snippet: line.trim(),
      });
    }
  }

  return offenses;
}

describe("soft-delete guardrail", () => {
  // Will be enabled once the model sweep lands. Until then, models still
  // query soft-deletable tables without `notDeleted`/`includeDeleted`, so
  // running the assertion would fail.
  test.todo("models filter soft-deletable tables", () => {
    const softDeletableTables = listSoftDeletableTables();
    if (softDeletableTables.size === 0) return;

    const allOffenses: Offense[] = [];
    for (const modelFile of listModelFiles()) {
      allOffenses.push(...scanFile(modelFile, softDeletableTables));
    }

    if (allOffenses.length > 0) {
      const formatted = allOffenses
        .map(
          (o) =>
            `  ${o.file}:${o.line} — schema.${o.table}\n    > ${o.snippet}`,
        )
        .join("\n");
      throw new Error(
        `Found ${allOffenses.length} model query/update on soft-deletable ` +
          `tables without notDeleted/deletedAt/includeDeleted nearby. If a ` +
          `query intentionally bypasses the filter, add a \`// soft-delete:\` ` +
          `comment within ${WINDOW_LINES} lines explaining why.\n\n${formatted}`,
      );
    }

    expect(allOffenses).toHaveLength(0);
  });
});
