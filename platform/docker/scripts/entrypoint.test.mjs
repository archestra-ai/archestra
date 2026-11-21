import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { prepare } from "./entrypoint.mjs";

const dataDir = () => mkdtempSync(path.join(tmpdir(), "entrypoint-"));
const database = { ARCHESTRA_DATABASE_URL: "postgres://u:p%40ss@db:5432/archestra?sslmode=require" };

test("refuses the quickstart and a missing database, naming the docker run image", () => {
  const quickstart = prepare({ ...database, ARCHESTRA_QUICKSTART: "true", ARCHESTRA_VERSION: "1.5.0" }, { dataDir: dataDir() });
  assert.match(quickstart.error, /no quickstart/);
  assert.match(quickstart.error, /archestra\/platform:1\.5\.0\./);
  assert.match(prepare({}, { dataDir: dataDir() }).error, /no bundled PostgreSQL/);
});

test("exports the database URL verbatim, preferring ARCHESTRA_DATABASE_URL", () => {
  const { env, error } = prepare({ ...database, DATABASE_URL: "postgres://other" }, { dataDir: dataDir() });
  assert.equal(error, undefined);
  assert.equal(env.DATABASE_URL, database.ARCHESTRA_DATABASE_URL);
  assert.equal(prepare({ DATABASE_URL: "postgres://x" }, { dataDir: dataDir() }).env.DATABASE_URL, "postgres://x");
});

test("generates a private auth secret once and loads it on the next start", () => {
  const directory = dataDir();
  const first = prepare(database, { dataDir: directory });
  assert.match(first.env.ARCHESTRA_AUTH_SECRET, /^[A-Za-z0-9]{64}$/);
  const file = path.join(directory, ".auth_secret");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(prepare(database, { dataDir: directory }).env.ARCHESTRA_AUTH_SECRET, first.env.ARCHESTRA_AUTH_SECRET);
  assert.equal(prepare({ ...database, ARCHESTRA_AUTH_SECRET: "set" }, { dataDir: directory }).env.ARCHESTRA_AUTH_SECRET, "set");
  writeFileSync(file, "from-an-older-image\n");
  assert.equal(prepare(database, { dataDir: directory }).env.ARCHESTRA_AUTH_SECRET, "from-an-older-image");
});

test("fails when it cannot keep a generated secret", { skip: process.getuid?.() === 0 }, () => {
  const directory = dataDir();
  chmodSync(directory, 0o500);
  assert.match(prepare(database, { dataDir: directory }).error, /not writable/);
});

test("puts both servers on one valid keep-alive window", () => {
  const run = (value) => prepare({ ...database, ARCHESTRA_AUTH_SECRET: "x", ARCHESTRA_HTTP_KEEP_ALIVE_TIMEOUT_MS: value }, { dataDir: dataDir() });
  assert.equal(run(undefined).env.ARCHESTRA_HTTP_KEEP_ALIVE_TIMEOUT_MS, "620000");
  assert.equal(run("").env.ARCHESTRA_HTTP_KEEP_ALIVE_TIMEOUT_MS, "620000");
  assert.equal(run("75000").env.ARCHESTRA_HTTP_KEEP_ALIVE_TIMEOUT_MS, "75000");
  for (const bad of ["0", "-5", "1.5", "620s", "abc"]) {
    const result = run(bad);
    assert.equal(result.env.ARCHESTRA_HTTP_KEEP_ALIVE_TIMEOUT_MS, "620000", bad);
    assert.match(result.messages.join("\n"), /WARNING: invalid/, bad);
  }
});

test("derives the backend's stop timeout and rejects an invalid drain", () => {
  const base = { ...database, ARCHESTRA_AUTH_SECRET: "x" };
  assert.equal(prepare(base, { dataDir: dataDir() }).env.ARCHESTRA_SERVER_SUPERVISOR_STOP_SECONDS, "90");
  assert.match(prepare({ ...base, ARCHESTRA_SERVER_REQUEST_DRAIN_SECONDS: "0" }, { dataDir: dataDir() }).error, /must be integer seconds/);
});

test("the generated secret is the file's content", () => {
  const directory = dataDir();
  const { env } = prepare(database, { dataDir: directory });
  assert.equal(readFileSync(path.join(directory, ".auth_secret"), "utf8").trim(), env.ARCHESTRA_AUTH_SECRET);
});
