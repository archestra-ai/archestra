import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "vitest";

const migration = readFileSync(
  new URL("./0603_living_black_tom.sql", import.meta.url),
  "utf8",
);

async function makeDatabase() {
  const database = new PGlite();
  await database.exec(`
    CREATE TABLE secret (
      id text PRIMARY KEY,
      secret jsonb NOT NULL,
      is_vault boolean NOT NULL DEFAULT false,
      is_byos_vault boolean NOT NULL DEFAULT false
    );
    CREATE TABLE team_vault_folder (id text PRIMARY KEY, vault_path text);
    CREATE TABLE connection (secret_id text REFERENCES secret(id));
    INSERT INTO secret VALUES
      ('database', '{"apiKey":"stored-token"}', false, false),
      ('managed', '{}', true, false),
      ('empty', '{}', false, true);
    INSERT INTO connection VALUES ('database'), ('managed'), ('empty');
    INSERT INTO team_vault_folder VALUES ('team', 'secret/data/team');
  `);
  return database;
}

test.each([
  false,
  true,
])("upgrades supported storage without changing credentials or breaking associations (outer transaction: %s)", async (transactional) => {
  const database = await makeDatabase();
  try {
    if (transactional) await database.exec("BEGIN");
    await database.exec(migration);
    if (transactional) await database.exec("COMMIT");
    expect(
      (await database.query("SELECT * FROM secret ORDER BY id")).rows,
    ).toEqual([
      { id: "database", secret: { apiKey: "stored-token" }, is_vault: false },
      { id: "empty", secret: {}, is_vault: false },
      { id: "managed", secret: {}, is_vault: true },
    ]);
    expect(
      (await database.query("SELECT * FROM connection")).rows,
    ).toHaveLength(3);
    expect(
      (await database.query("SELECT to_regclass('team_vault_folder') AS name"))
        .rows,
    ).toEqual([{ name: null }]);
  } finally {
    await database.close();
  }
});

test.each(
  [
    { apiKey: "secret/data/provider#token" },
    { access_token: "real-token-with-an-incorrect-storage-flag" },
    { __encrypted: "opaque-payload" },
  ].flatMap((payload) =>
    [false, true].map((transactional) => ({ payload, transactional })),
  ),
)("stops before schema changes when a populated payload has uncertain storage: %j", async ({
  payload,
  transactional,
}) => {
  const database = await makeDatabase();
  try {
    await database.query(
      "INSERT INTO secret VALUES ('uncertain', $1, false, true)",
      [payload],
    );
    await database.query("INSERT INTO connection VALUES ('uncertain')");
    if (transactional) await database.exec("BEGIN");
    await expect(database.exec(migration)).rejects.toThrow(
      "Secret storage needs reconfiguration",
    );
    if (transactional) await database.exec("ROLLBACK");
    expect(
      (
        await database.query(
          "SELECT secret, is_byos_vault FROM secret WHERE id = 'uncertain'",
        )
      ).rows,
    ).toEqual([{ secret: payload, is_byos_vault: true }]);
    expect(
      (await database.query("SELECT * FROM connection")).rows,
    ).toHaveLength(4);
    expect(
      (await database.query("SELECT * FROM team_vault_folder")).rows,
    ).toHaveLength(1);
  } finally {
    await database.close();
  }
});
