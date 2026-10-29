import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { __setTestDb, schema } from "../src/database";
import AgentRunModel from "../src/models/agent-run";

// Explicit opt-in, using a disposable local database and the production pg
// driver: PGlite does not reproduce node-postgres Date serialization.
// ARCHESTRA_DATABASE_URL=<synthetic URL> ARCHESTRA_RUNTIME_ALERT_TEST_DATABASE_URL=<local URL>
// TSX_TSCONFIG_PATH=standalone-scripts.tsconfig.json pnpm exec tsx --test scripts/runtime-failure-window-postgres.test.ts
const connectionString = process.env.ARCHESTRA_RUNTIME_ALERT_TEST_DATABASE_URL;
assert.ok(
  connectionString,
  "A task-owned local PostgreSQL database is required",
);
const url = new URL(connectionString);
assert.ok(
  ["localhost", "127.0.0.1"].includes(url.hostname) &&
    url.pathname.startsWith("/archestra_runtime_alert_test"),
  "Refusing a shared or non-local database",
);

test("failed-turn cutoff stays in UTC through node-postgres in either timezone direction", async () => {
  const pool = new Pool({ connectionString, max: 1 });
  const namespace = `runtime_alert_${randomUUID().replaceAll("-", "")}`;
  const originalTimezone = process.env.TZ;
  __setTestDb(drizzle(pool, { schema }));
  try {
    await pool.query(`CREATE SCHEMA "${namespace}"`);
    await pool.query(`SET search_path TO "${namespace}"`);
    // Only the production columns read by listDashboard; the real model and
    // driver execute the complete filter, joins, ordering and limit.
    await pool.query(`
      CREATE TABLE agents (id uuid PRIMARY KEY, name text, icon text, runtime jsonb);
      CREATE TABLE "user" (id text PRIMARY KEY, name text);
      CREATE TABLE a2a_task (id uuid PRIMARY KEY, state text, status_reason text,
        failure jsonb, state_changed_at timestamp);
      CREATE TABLE agent_runs (id uuid PRIMARY KEY, task_id uuid, agent_id uuid,
        organization_id text, title text, actor_kind text, actor_id text,
        actor_user_id text, workload_name text, started_at timestamp,
        ended_at timestamp, active_deadline_seconds integer, attention_state text,
        completion_target jsonb);
      CREATE TABLE agent_workspaces (id uuid, workload_name text, last_task_id uuid);
      CREATE TABLE chatops_channel_binding (id uuid, provider text,
        workspace_id text, channel_id text, channel_name text, organization_id text);
      CREATE TABLE interactions (run_id text, created_at timestamp);
      CREATE TABLE a2a_message (id uuid, task_id uuid, parts jsonb, role text, created_at timestamp);
    `);
    const agentId = randomUUID();
    await pool.query(
      "INSERT INTO agents VALUES ($1, 'Synthetic worker', NULL, NULL)",
      [agentId],
    );
    const tasks = [randomUUID(), randomUUID(), randomUUID()];
    const changed = [
      "2026-01-02T11:44:59.000Z",
      "2026-01-02T11:45:00.000Z",
      "2026-01-02T11:50:00.000Z",
    ];
    for (const [index, taskId] of tasks.entries()) {
      await pool.query(
        "INSERT INTO a2a_task (id, state, state_changed_at) VALUES ($1, 'TASK_STATE_FAILED', $2)",
        [taskId, changed[index]],
      );
      await pool.query(
        "INSERT INTO agent_runs (id, task_id, agent_id, organization_id, workload_name, started_at) VALUES ($1, $2, $3, 'synthetic-org', $4, '2026-01-01T00:00:00Z')",
        [randomUUID(), taskId, agentId, `synthetic-${index}`],
      );
    }
    for (const timezone of ["America/New_York", "Asia/Tokyo"]) {
      process.env.TZ = timezone;
      const cutoff = new Date("2026-01-02T11:45:00Z");
      assert.notEqual(cutoff.getTimezoneOffset(), 0);
      const result = await AgentRunModel.listDashboard({
        agentIds: [agentId],
        organizationId: "synthetic-org",
        limit: 100,
        state: "TASK_STATE_FAILED",
        failedSince: cutoff,
      });
      assert.deepEqual(
        result.map((row) => row.taskId),
        [tasks[2], tasks[1]],
        timezone,
      );
    }
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
    __setTestDb(null);
    await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await pool.end();
  }
});
