import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { McpGatewayTaskModel } from "@/models";
import { mcpGatewayTaskReaper } from "@/services/mcp-gateway-task-reaper";
import { describe, expect, test } from "@/test";

const TTL_MS = 30 * 60 * 1000;

/**
 * The post-TTL lifecycle the Tasks extension sanctions: after the TTL a
 * server "MAY mark a task as `failed` … and subsequently delete it at any
 * time". Step one settles orphans (a `working` row past expiry belongs to a
 * dead executor); step two purges rows past the retention grace.
 */
describe("MCP gateway task reaper", () => {
  /** Create a row whose expiry is `expiresInMs` from now (negative = past). */
  async function makeTask(
    agentId: string,
    expiresInMs: number,
    status?: "completed" | "failed" | "cancelled",
  ) {
    const task = await McpGatewayTaskModel.create({
      agentId,
      principal: "user:reaper-test",
      toolName: "slow-lab__slow_report",
      ttlMs: expiresInMs,
    });
    if (status === "completed") {
      await McpGatewayTaskModel.completeIfWorking(task.id, { ok: true });
    } else if (status === "failed") {
      await McpGatewayTaskModel.failIfWorking(task.id, { code: -32603 });
    } else if (status === "cancelled") {
      await McpGatewayTaskModel.cancelIfWorking(task.id);
    }
    return task;
  }

  async function rowById(taskId: string) {
    const [row] = await db
      .select()
      .from(schema.mcpGatewayTasksTable)
      .where(eq(schema.mcpGatewayTasksTable.id, taskId));
    return row ?? null;
  }

  test("marks expired working rows failed and leaves everything else alone", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const orphan = await makeTask(agent.id, -1_000);
    const liveWorking = await makeTask(agent.id, TTL_MS);
    const expiredCompleted = await makeTask(agent.id, -1_000, "completed");
    const expiredCancelled = await makeTask(agent.id, -1_000, "cancelled");

    const failed = await McpGatewayTaskModel.failExpired();

    expect(failed).toBe(1);
    const orphanRow = await rowById(orphan.id);
    expect(orphanRow?.status).toBe("failed");
    // The error explains what happened, in the JSON-RPC shape tasks/get serves.
    expect(orphanRow?.error).toMatchObject({
      code: -32603,
      message: expect.stringContaining("expired"),
    });

    // A still-live execution is untouched; terminal outcomes are never
    // rewritten — a completed task must not become a failed one.
    expect((await rowById(liveWorking.id))?.status).toBe("working");
    expect((await rowById(expiredCompleted.id))?.status).toBe("completed");
    expect((await rowById(expiredCancelled.id))?.status).toBe("cancelled");
  });

  test("purges rows past the grace window regardless of status, keeps the rest", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const pastGraceWorking = await makeTask(agent.id, -TTL_MS - 60_000);
    const pastGraceCompleted = await makeTask(
      agent.id,
      -TTL_MS - 60_000,
      "completed",
    );
    // Expired, but within the grace window: kept for operator inspection.
    const withinGrace = await makeTask(agent.id, -1_000, "failed");
    const live = await makeTask(agent.id, TTL_MS);

    const purged = await McpGatewayTaskModel.purgeExpired({ graceMs: TTL_MS });

    expect(purged).toBe(2);
    expect(await rowById(pastGraceWorking.id)).toBeNull();
    expect(await rowById(pastGraceCompleted.id)).toBeNull();
    expect(await rowById(withinGrace.id)).not.toBeNull();
    expect(await rowById(live.id)).not.toBeNull();
  });

  test("a sweep runs the spec sequence: orphans become failed first, deletion only after grace", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    // Freshly-expired orphan: must be marked failed by this sweep, NOT
    // deleted — it is within the grace window.
    const freshOrphan = await makeTask(agent.id, -1_000);
    // Long-dead orphan: past the grace, this sweep removes it entirely.
    const oldOrphan = await makeTask(agent.id, -TTL_MS - 60_000);

    const outcome = await mcpGatewayTaskReaper.sweep();

    // Both orphans were `working` past expiry, so both are marked failed;
    // only the one past the grace is then purged.
    expect(outcome).toEqual({ failed: 2, purged: 1 });
    expect((await rowById(freshOrphan.id))?.status).toBe("failed");
    expect(await rowById(oldOrphan.id)).toBeNull();
  });

  test("a concurrent settle beats the reaper, matching the cancellation race rule", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const task = await makeTask(agent.id, -1_000);

    // The execution's outcome lands just before the sweep's guarded UPDATE.
    await McpGatewayTaskModel.completeIfWorking(task.id, {
      content: [{ type: "text", text: "made it" }],
    });
    const failed = await McpGatewayTaskModel.failExpired();

    expect(failed).toBe(0);
    const row = await rowById(task.id);
    expect(row?.status).toBe("completed");
    expect(row?.result).toMatchObject({
      content: [{ type: "text", text: "made it" }],
    });
  });
});
