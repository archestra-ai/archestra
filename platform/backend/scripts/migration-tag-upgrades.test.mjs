// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

// Replays real released histories with the real Drizzle migrator: migrate a
// database with the exact migration set of each active stable line's latest
// release tag, then upgrade it to this worktree's history. The upgraded schema
// must converge with a from-scratch install, no migration may replay, and
// unrelated existing data must survive. This is the SQL-level complement to
// .github/scripts/check-migration-upgrades.py, which validates journal
// timestamps and hashes without executing anything.
//
// Release tags are discovered per active stable branch (release/X.Y ships
// platform-vX.Y.Z tags), so new stable lines join the matrix automatically.
// Fetch tags before running: git fetch origin '+refs/tags/platform-v*:refs/tags/platform-v*'

const migrations = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/database/migrations",
);
const migrationsRepoPath = "platform/backend/src/database/migrations";
const probeTable = "migration_upgrade_probe";
const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: migrations,
  encoding: "utf8",
}).trim();

// Production migrates over node-postgres, which accepts multi-command
// statements; some early migrations rely on that. PGlite's query path uses the
// extended protocol and rejects them, poisoning the surrounding transaction,
// so multi-command statements must be routed to exec (simple protocol) before
// PGlite parses them. The executed SQL text is unchanged, and Drizzle's ledger
// hash is computed from the migration file, not per-statement chunks, so
// replay fidelity is preserved.
class MigrationPGlite extends PGlite {
  async query(query, params, options) {
    if ((!params || params.length === 0) && hasMultipleStatements(query)) {
      await super.exec(query);
      return { rows: [], fields: [], affectedRows: 0 };
    }
    return super.query(query, params, options);
  }

  async transaction(callback) {
    return super.transaction(async (tx) => {
      const original = tx.query.bind(tx);
      tx.query = async (query, params, options) => {
        if ((!params || params.length === 0) && hasMultipleStatements(query)) {
          await tx.exec(query);
          return { rows: [], fields: [], affectedRows: 0 };
        }
        return original(query, params, options);
      };
      return callback(tx);
    });
  }
}

// Counts top-level semicolons, skipping string literals, quoted identifiers,
// comments, and dollar-quoted bodies. Two or more means node-postgres would
// have run this as a multi-command simple query.
function hasMultipleStatements(text) {
  let semicolons = 0;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === "'") {
      i++;
      while (i < text.length) {
        if (text[i] === "'" && text[i + 1] === "'") i += 2;
        else if (text[i] === "'") { i++; break; }
        else i++;
      }
    } else if (char === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i++;
      i++;
    } else if (char === "-" && text[i + 1] === "-") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (char === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else if (char === "$") {
      const tag = /^\$[A-Za-z0-9_]*\$/.exec(text.slice(i))?.[0];
      if (tag) {
        const end = text.indexOf(tag, i + tag.length);
        i = end === -1 ? text.length : end + tag.length;
      } else {
        i++;
      }
    } else {
      if (char === ";") semicolons++;
      i++;
    }
  }
  return semicolons > 1;
}

const sourceTags = latestStableTags();
assert.ok(
  sourceTags.length > 0,
  "No stable release tags found; fetch them with: " +
    "git fetch origin '+refs/tags/platform-v*:refs/tags/platform-v*'",
);

const targetJournal = JSON.parse(
  await readFile(path.join(migrations, "meta/_journal.json"), "utf8"),
);
const targetMaxWhen = Math.max(...targetJournal.entries.map((e) => e.when));
const targetHashes = new Map(
  await Promise.all(
    targetJournal.entries.map(async (entry) => [
      entry.tag,
      hashSql(await readFile(path.join(migrations, `${entry.tag}.sql`))),
    ]),
  ),
);

test("from-scratch install and every released stable upgrade converge", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "archestra-tag-upgrade-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));

  const fresh = new MigrationPGlite("memory://", { extensions: { vector } });
  t.after(() => fresh.close());
  await migrate(drizzle(fresh), { migrationsFolder: migrations });
  const freshCatalog = await catalogDump(fresh);

  for (const tag of sourceTags) {
    await t.test(`upgrade from ${tag}`, async (t) => {
      const sourceFolder = await extractMigrations(
        tag,
        path.join(directory, tag),
      );
      const sourceJournal = JSON.parse(
        await readFile(
          path.join(sourceFolder, "meta/_journal.json"),
          "utf8",
        ),
      );
      const sourceHashes = new Set(
        await Promise.all(
          sourceJournal.entries.map(async (entry) =>
            hashSql(await readFile(path.join(sourceFolder, `${entry.tag}.sql`)))
          ),
        ),
      );
      const sourceMaxWhen = Math.max(
        ...sourceJournal.entries.map((e) => e.when),
      );

      const upgraded = new MigrationPGlite("memory://", { extensions: { vector } });
      t.after(() => upgraded.close());
      await migrate(drizzle(upgraded), { migrationsFolder: sourceFolder });
      // Stand-in for pre-existing application data that no migration owns.
      await upgraded.exec(
        `CREATE TABLE ${probeTable} (id text PRIMARY KEY); INSERT INTO ${probeTable} VALUES ('keep-me');`,
      );
      await migrate(drizzle(upgraded), { migrationsFolder: migrations });

      assert.deepEqual(
        await catalogDump(upgraded),
        freshCatalog,
        "upgraded schema diverged from a fresh install",
      );
      assert.deepEqual(
        (await upgraded.query(`SELECT id FROM ${probeTable}`)).rows,
        [{ id: "keep-me" }],
        "upgrade dropped pre-existing data",
      );
      assert.deepEqual(
        (
          await upgraded.query(
            "SELECT hash FROM drizzle.__drizzle_migrations GROUP BY hash HAVING count(*) > 1",
          )
        ).rows,
        [],
        "a migration was applied twice",
      );

      // Every target migration newer than the source watermark must be
      // recorded unless its exact SQL already ran on the source line (a
      // renamed backport). This catches silently skipped data migrations,
      // which a schema comparison cannot see.
      const expectedLedger =
        sourceJournal.entries.length +
        targetJournal.entries.filter(
          (entry) =>
            entry.when > sourceMaxWhen &&
            !sourceHashes.has(targetHashes.get(entry.tag)),
        ).length;
      const ledgerCount = (
        await upgraded.query(
          "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations",
        )
      ).rows[0].count;
      assert.equal(
        ledgerCount,
        expectedLedger,
        "migration ledger does not match the expected applied set",
      );
      const watermark = (
        await upgraded.query(
          "SELECT max(created_at)::text AS watermark FROM drizzle.__drizzle_migrations",
        )
      ).rows[0].watermark;
      assert.equal(watermark, String(targetMaxWhen));
    });
  }
});

function latestStableTags() {
  const branches = git([
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/remotes/origin/release/",
  ])
    .split("\n")
    .map((ref) => /^origin\/release\/(\d+\.\d+)$/.exec(ref)?.[1])
    .filter(Boolean);
  const tags = [];
  for (const line of branches) {
    const candidates = git(["tag", "--list", `platform-v${line}.*`])
      .split("\n")
      .filter((tag) => /^platform-v\d+\.\d+\.\d+$/.test(tag))
      .sort(compareVersions);
    if (candidates.length > 0) {
      tags.push(candidates[candidates.length - 1]);
    }
  }
  return [...new Set(tags)];
}

async function extractMigrations(ref, directory) {
  await mkdir(directory, { recursive: true });
  const files = git([
    "ls-tree",
    "-r",
    "--name-only",
    ref,
    "--",
    migrationsRepoPath,
  ])
    .split("\n")
    .filter((name) => name.endsWith(".sql") || name.endsWith("_journal.json"));
  const archive = execFileSync("git", ["archive", ref, "--", ...files], {
    cwd: repoRoot,
    maxBuffer: 512 * 1024 * 1024,
  });
  const archivePath = path.join(directory, "migrations.tar");
  await writeFile(archivePath, archive);
  execFileSync("tar", ["-xf", archivePath, "-C", directory]);
  await rm(archivePath);
  return path.join(directory, migrationsRepoPath);
}

async function catalogDump(pg) {
  const query = (sql) => pg.query(sql).then((result) => result.rows);
  return {
    tables: await query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       AND table_name <> '${probeTable}' ORDER BY 1`,
    ),
    columns: await query(
      `SELECT table_name, column_name, udt_name, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name <> '${probeTable}'
       ORDER BY 1, 2`,
    ),
    constraints: await query(
      `SELECT con.conname, pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
       WHERE nsp.nspname = 'public' AND rel.relname <> '${probeTable}'
       ORDER BY 1, 2`,
    ),
    indexes: await query(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename <> '${probeTable}'
       ORDER BY 1`,
    ),
    enums: await query(
      `SELECT t.typname, e.enumlabel FROM pg_type t
       JOIN pg_enum e ON e.enumtypid = t.oid
       JOIN pg_namespace nsp ON nsp.oid = t.typnamespace
       WHERE nsp.nspname = 'public' ORDER BY 1, e.enumsortorder`,
    ),
  };
}

function hashSql(content) {
  return createHash("sha256").update(content).digest("hex");
}

function compareVersions(a, b) {
  const pa = a.replace("platform-v", "").split(".").map(Number);
  const pb = b.replace("platform-v", "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}
