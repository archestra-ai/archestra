import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "vitest";

test("consolidates existing credentials without changing secrets, ownership, or GitHub references", async () => {
  const database = new PGlite();
  try {
    await database.exec(
      'CREATE TABLE "user" (id text PRIMARY KEY); CREATE TABLE service_accounts (id uuid PRIMARY KEY); CREATE TABLE secret (id uuid PRIMARY KEY, secret jsonb);',
    );
    const snapshot = JSON.parse(
      fs.readFileSync(
        new URL("./meta/0469_snapshot.json", import.meta.url),
        "utf8",
      ),
    );
    const names = [
      "github_app_configs",
      "github_pats",
      "runtime_credential_definitions",
      "runtime_credential_connections",
    ];
    for (const name of names) {
      const table = snapshot.tables[`public.${name}`];
      const columns = Object.values(table.columns).map((column) => {
        const c = column as {
          name: string;
          type: string;
          primaryKey: boolean;
          notNull: boolean;
          default?: string;
        };
        return `"${c.name}" ${c.type}${c.primaryKey ? " PRIMARY KEY" : ""}${c.notNull ? " NOT NULL" : ""}${c.default !== undefined ? ` DEFAULT ${c.default}` : ""}`;
      });
      await database.exec(`CREATE TABLE "${name}" (${columns.join(",")});`);
      for (const fk of Object.values(table.foreignKeys)) {
        const f = fk as {
          name: string;
          columnsFrom: string[];
          tableTo: string;
          columnsTo: string[];
        };
        await database.exec(
          `ALTER TABLE "${name}" ADD CONSTRAINT "${f.name}" FOREIGN KEY (${f.columnsFrom.map((c) => `"${c}"`).join(",")}) REFERENCES "${f.tableTo}" (${f.columnsTo.map((c) => `"${c}"`).join(",")});`,
        );
      }
      for (const check of Object.values(table.checkConstraints)) {
        const c = check as { name: string; value: string };
        await database.exec(
          `ALTER TABLE "${name}" ADD CONSTRAINT "${c.name}" CHECK (${c.value});`,
        );
      }
      for (const index of Object.values(table.indexes)) {
        const i = index as {
          name: string;
          isUnique: boolean;
          columns: { expression: string }[];
          where?: string;
        };
        await database.exec(
          `CREATE ${i.isUnique ? "UNIQUE " : ""}INDEX "${i.name}" ON "${name}" (${i.columns.map((c) => `"${c.expression}"`).join(",")})${i.where ? ` WHERE ${i.where}` : ""};`,
        );
      }
    }
    for (const name of ["skills", "plugins"]) {
      await database.exec(
        `CREATE TABLE "${name}" (id uuid PRIMARY KEY, github_app_config_id uuid CONSTRAINT "${name}_github_app_config_id_github_app_configs_id_fk" REFERENCES github_app_configs(id), github_pat_id uuid CONSTRAINT "${name}_github_pat_id_github_pats_id_fk" REFERENCES github_pats(id));`,
      );
    }
    await database.exec(`
      CREATE TABLE organization_role (id text PRIMARY KEY, permission text NOT NULL);
      INSERT INTO "user" VALUES ('owner');
      INSERT INTO secret VALUES ('00000000-0000-4000-8000-000000000001', '{"apiToken":"opaque-reference"}');
      INSERT INTO github_app_configs (id, organization_id, name, app_id, installation_id, secret_id) VALUES ('00000000-0000-4000-8000-000000000002', 'org', 'Repository App', '123', '456', '00000000-0000-4000-8000-000000000001');
      INSERT INTO github_pats (id, organization_id, name, secret_id) VALUES ('00000000-0000-4000-8000-000000000003', 'org', 'Repository PAT', '00000000-0000-4000-8000-000000000001');
      INSERT INTO runtime_credential_definitions (organization_id, key, name) VALUES ('org', 'personal-token', 'Personal token');
      INSERT INTO runtime_credential_connections (organization_id, scope, user_id, credential_id, secret_id) VALUES ('org', 'personal', 'owner', 'personal-token', '00000000-0000-4000-8000-000000000001');
      INSERT INTO skills VALUES ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000002', null);
      INSERT INTO plugins VALUES ('00000000-0000-4000-8000-000000000005', null, '00000000-0000-4000-8000-000000000003');
      INSERT INTO organization_role VALUES ('custom', '{"githubAppConfig":["read","update"]}');
    `);
    const migration = fs.readFileSync(
      new URL("./0470_lush_jackpot.sql", import.meta.url),
      "utf8",
    );
    await database.exec(`BEGIN; ${migration} COMMIT;`);
    expect(
      (
        await database.query(
          "SELECT kind FROM credential_definitions ORDER BY kind",
        )
      ).rows,
    ).toEqual([{ kind: "github_app" }, { kind: "secret" }, { kind: "secret" }]);
    expect(
      (
        await database.query(
          "SELECT scope, user_id, secret_key FROM credential_connections ORDER BY credential_id",
        )
      ).rows,
    ).toEqual([
      { scope: "organization", user_id: null, secret_key: "apiToken" },
      { scope: "organization", user_id: null, secret_key: "apiToken" },
      { scope: "personal", user_id: "owner", secret_key: "value" },
    ]);
    expect((await database.query("SELECT secret FROM secret")).rows).toEqual([
      { secret: { apiToken: "opaque-reference" } },
    ]);
    expect(
      (
        await database.query(
          "SELECT count(*)::int AS count FROM skills JOIN credential_definitions ON skills.github_app_config_id = credential_definitions.id",
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    expect(
      (
        await database.query(
          "SELECT count(*)::int AS count FROM plugins JOIN credential_definitions ON plugins.github_pat_id = credential_definitions.id",
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    expect(
      (
        await database.query(
          "SELECT permission::jsonb AS permission FROM organization_role",
        )
      ).rows,
    ).toEqual([{ permission: { credential: ["read", "update"] } }]);
  } finally {
    await database.close();
  }
});
