// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

const migrations = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/database/migrations",
);
const journal = JSON.parse(
  await readFile(path.join(migrations, "meta/_journal.json"), "utf8"),
);
const repairTag = "0464_repair_release_track_columns";
const betaTags = [
  "0459_team-role-composition",
  "0460_wet_arclight",
  "0461_worthless_christian_walker",
];

// Minimal pre-upgrade tables keep this test focused on the actual Drizzle
// timestamp selection and the production DDL, without booting the application.
const bootstrapSql = `
  CREATE TABLE team (id text PRIMARY KEY);
  --> statement-breakpoint
  CREATE TABLE knowledge_bases (id text PRIMARY KEY);
  --> statement-breakpoint
  CREATE TABLE chat_api_keys (id text PRIMARY KEY);
  --> statement-breakpoint
  INSERT INTO team VALUES ('existing-team');
  --> statement-breakpoint
  INSERT INTO knowledge_bases VALUES ('existing-kb');
`;
const bootstrap = {
  idx: 0,
  tag: "bootstrap",
  when: 1000,
  breakpoints: true,
  version: "7",
};

for (const advancedWatermark of [false, true]) {
  test(`stable-to-beta upgrade repairs skipped columns (later migrations applied: ${advancedWatermark})`, async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "archestra-migration-upgrade-"),
    );
    const pg = new PGlite();
    t.after(async () => {
      await pg.close();
      await rm(directory, { recursive: true, force: true });
    });
    const db = drizzle(pg);
    const backportSql = await readFile(
      path.join(migrations, "0461_worthless_christian_walker.sql"),
      "utf8",
    );
    const stable = await writeHistory({
      directory,
      name: "stable",
      entries: [
        bootstrap,
        // v1.3.56 shipped this identical SQL under a different name and a later timestamp.
        {
          idx: 1,
          tag: "0459_worthless_christian_walker",
          when: 1788918138111,
          breakpoints: true,
          version: "7",
        },
      ],
      extraSql: {
        bootstrap: bootstrapSql,
        "0459_worthless_christian_walker": backportSql,
      },
    });
    await migrate(db, { migrationsFolder: stable });
    // Model a beta that applied unrelated later DDL before startup failed.
    const later = {
      idx: 462,
      tag: "later_beta_change",
      when: 1788969217005,
      breakpoints: true,
      version: "7",
    };
    const upgradeEntries = [
      bootstrap,
      ...entriesFor(betaTags),
      ...(advancedWatermark ? [later] : []),
    ];
    const extraSql = {
      bootstrap: bootstrapSql,
      later_beta_change: "CREATE TABLE later_feature (id text PRIMARY KEY);",
    };
    const beta = await writeHistory({
      directory,
      name: "beta",
      entries: upgradeEntries,
      extraSql,
    });
    // The old upgrade reports success while these columns are still absent.
    await migrate(db, { migrationsFolder: beta });
    assert.equal(
      (
        await pg.query(
          "SELECT max(created_at)::text AS watermark FROM drizzle.__drizzle_migrations",
        )
      ).rows[0].watermark,
      advancedWatermark ? "1788969217005" : "1788918138111",
    );
    await assert.rejects(
      pg.query("SELECT roles FROM team"),
      /column "roles" does not exist/,
    );
    await assert.rejects(
      pg.query("SELECT visibility, team_ids FROM knowledge_bases"),
      /does not exist/,
    );
    const repaired = await writeHistory({
      directory,
      name: "repaired",
      entries: [...upgradeEntries, ...entriesFor([repairTag])],
      extraSql,
    });
    await migrate(db, { migrationsFolder: repaired });
    await migrate(db, { migrationsFolder: repaired });
    assert.deepEqual((await pg.query("SELECT id, roles FROM team")).rows, [
      { id: "existing-team", roles: [] },
    ]);
    assert.deepEqual(
      (await pg.query("SELECT id, visibility, team_ids FROM knowledge_bases"))
        .rows,
      [{ id: "existing-kb", visibility: "org-wide", team_ids: [] }],
    );
    assert.equal(
      (
        await pg.query(
          "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations",
        )
      ).rows[0].count,
      advancedWatermark ? 4 : 3,
    );
  });
}

for (const state of ["healthy", "partially repaired"]) {
  test(`repair preserves configured values on a ${state} database`, async (t) => {
    const pg = new PGlite();
    t.after(() => pg.close());
    await pg.exec(bootstrapSql);
    await pg.exec(
      await readFile(
        path.join(migrations, "0459_team-role-composition.sql"),
        "utf8",
      ),
    );
    await pg.exec("UPDATE team SET roles = ARRAY['custom-role']");
    if (state === "healthy") {
      await pg.exec(
        await readFile(path.join(migrations, "0460_wet_arclight.sql"), "utf8"),
      );
      await pg.exec(
        `UPDATE knowledge_bases SET visibility = 'team', team_ids = '["existing-team"]'::jsonb`,
      );
    }
    const repairSql = await readFile(
      path.join(migrations, `${repairTag}.sql`),
      "utf8",
    );
    // Execute twice to check SQL idempotence independently of ledger skipping.
    await pg.exec(`BEGIN; ${repairSql} COMMIT;`);
    await pg.exec(`BEGIN; ${repairSql} COMMIT;`);
    assert.deepEqual((await pg.query("SELECT roles FROM team")).rows, [
      { roles: ["custom-role"] },
    ]);
    assert.deepEqual(
      (await pg.query("SELECT visibility, team_ids FROM knowledge_bases")).rows,
      [
        {
          visibility: state === "healthy" ? "team" : "org-wide",
          team_ids: state === "healthy" ? ["existing-team"] : [],
        },
      ],
    );
  });
}

function entriesFor(tags) {
  return tags.map((tag) => {
    const entry = journal.entries.find((entry) => entry.tag === tag);
    assert.ok(entry, `Missing production migration: ${tag}`);
    return entry;
  });
}

async function writeHistory({ directory, name, entries, extraSql }) {
  const folder = path.join(directory, name);
  await mkdir(path.join(folder, "meta"), { recursive: true });
  await writeFile(
    path.join(folder, "meta/_journal.json"),
    JSON.stringify({ version: "7", dialect: "postgresql", entries }),
  );
  for (const entry of entries) {
    const sql =
      extraSql[entry.tag] ??
      (await readFile(path.join(migrations, `${entry.tag}.sql`), "utf8"));
    await writeFile(path.join(folder, `${entry.tag}.sql`), sql);
  }
  return folder;
}
