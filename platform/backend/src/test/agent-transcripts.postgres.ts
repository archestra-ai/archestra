import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import db, { initializeDatabase } from "@/database";
import A2AContextModel from "@/models/a2a/context";
import A2ATaskModel from "@/models/a2a/task";
import AgentModel from "@/models/agent";
import AgentRunModel from "@/models/agent-run";
import OrganizationModel from "@/models/organization";
import { verifyConcurrentTranscriptReplacement } from "./agent-transcript-concurrency";

for (const readable of [false, true]) {
  test(`PostgreSQL serializes concurrent ${readable ? "readable" : "terminal"} recording replacements`, {
    timeout: 30_000,
  }, async () => {
    assert.ok(
      new URL(process.env.ARCHESTRA_DATABASE_URL ?? "").pathname.endsWith(
        "_test",
      ),
      "A migrated disposable *_test database is required",
    );
    await initializeDatabase();
    assert.ok(
      db.$client.options.max >= 10,
      "Set ARCHESTRA_DATABASE_POOL_MAX=16",
    );
    let agentId: string | undefined;
    try {
      const organization =
        await OrganizationModel.getOrCreateDefaultOrganization();
      const agent = await AgentModel.create({
        name: "Synthetic recording concurrency",
        organizationId: organization.id,
        teams: [],
        labels: [],
        knowledgeBaseIds: [],
        connectorIds: [],
      });
      agentId = agent.id;
      const context = await A2AContextModel.create({
        actorKind: "system",
        actorId: "recording-test",
      });
      const task = await A2ATaskModel.create({
        contextId: context.id,
        agentId: agent.id,
        state: "TASK_STATE_COMPLETED",
      });
      const run = await AgentRunModel.create({
        organizationId: organization.id,
        taskId: task.id,
        agentId: agent.id,
        actorKind: "system",
        actorId: "recording-test",
        workloadName: `recording-${task.id}`,
        backend: "kubernetes",
        runtimeScope: "test",
      });
      await verifyConcurrentTranscriptReplacement(run.id, readable);
      // Existing-row writers must all wait for the same header lock, then finish.
      const table = readable
        ? "agent_run_readable_transcripts"
        : "agent_run_transcripts";
      const blocker = await db.$client.connect();
      let pending: Promise<void> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query(
          `SELECT run_id FROM ${table} WHERE run_id = $1 FOR UPDATE`,
          [run.id],
        );
        pending = verifyConcurrentTranscriptReplacement(run.id, readable);
        void pending.catch(() => {});
        const deadline = Date.now() + 5_000;
        let waiting = 0;
        while (waiting < 8 && Date.now() < deadline) {
          const result = await db.$client.query<{ waiting: number }>(
            `SELECT count(*)::int AS waiting FROM pg_stat_activity
             WHERE datname = current_database() AND pid <> pg_backend_pid()
               AND wait_event_type = 'Lock' AND query LIKE $1`,
            [`%${table}%`],
          );
          waiting = result.rows[0].waiting;
          if (waiting < 8) await delay(10);
        }
        assert.equal(
          waiting,
          8,
          "All eight writers must reach the header lock",
        );
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        await pending;
      }
    } finally {
      if (agentId) await AgentModel.delete(agentId);
    }
  });
}

after(async () => {
  await db.$client.end();
});
