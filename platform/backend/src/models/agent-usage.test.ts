import { eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import type { InteractionRequest, InteractionResponse } from "@/types";
import { drainBackgroundWork } from "@/utils/background-work";
import AgentUsageModel from "./agent-usage";
import InteractionModel from "./interaction";
import McpToolCallModel from "./mcp-tool-call";

describe("AgentUsageModel", () => {
  const usageOf = async (agentId: string) => {
    const [row] = await db
      .select({
        lastUsedAt: schema.agentsTable.lastUsedAt,
        updatedAt: schema.agentsTable.updatedAt,
      })
      .from(schema.agentsTable)
      .where(eq(schema.agentsTable.id, agentId));
    return row;
  };

  const createMcpCall = (agentId: string | null) =>
    McpToolCallModel.create({
      agentId,
      mcpServerName: "test-server",
      method: "tools/list",
      toolCall: null,
      toolResult: null,
    });

  const createInteraction = (profileId: string | null) =>
    InteractionModel.create({
      profileId,
      request: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hello" }],
      } as unknown as InteractionRequest,
      response: {
        id: "resp",
        object: "chat.completion",
        choices: [],
      } as unknown as InteractionResponse,
      type: "openai:chatCompletions",
    });

  test("an MCP request stamps the agent with the call's time", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const before = await usageOf(agent.id);

    const call = await createMcpCall(agent.id);
    await drainBackgroundWork();

    const after = await usageOf(agent.id);
    expect(after.lastUsedAt).toEqual(call.createdAt);
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  test("an LLM call stamps the agent with the interaction's time", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const before = await usageOf(agent.id);

    const interaction = await createInteraction(agent.id);
    await drainBackgroundWork();

    const after = await usageOf(agent.id);
    expect(after.lastUsedAt).toEqual(interaction.createdAt);
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  test("log rows without an agent are written and stamp nothing", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();

    const call = await createMcpCall(null);
    const interaction = await createInteraction(null);
    await drainBackgroundWork();

    expect(call.id).toBeDefined();
    expect(interaction.id).toBeDefined();
    expect((await usageOf(agent.id)).lastUsedAt).toBeNull();
  });

  test("never moves the value back to an older use", async ({ makeAgent }) => {
    const agent = await makeAgent();
    const newer = new Date("2026-08-20T00:00:00.000Z");
    const older = new Date("2026-08-10T00:00:00.000Z");

    await AgentUsageModel.recordUse({ agentId: agent.id, usedAt: newer });
    await AgentUsageModel.recordUse({ agentId: agent.id, usedAt: older });

    expect((await usageOf(agent.id)).lastUsedAt).toEqual(newer);
  });

  test("background stamps of one agent are at most one per second", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const first = new Date("2026-08-10T00:00:00.000Z");
    const record = (offsetMs: number) => {
      AgentUsageModel.recordUseInBackground({
        agentId: agent.id,
        usedAt: new Date(first.getTime() + offsetMs),
      });
      return drainBackgroundWork();
    };

    await record(0);
    await record(500);
    expect((await usageOf(agent.id)).lastUsedAt).toEqual(first);

    await record(1_500);
    expect((await usageOf(agent.id)).lastUsedAt).toEqual(
      new Date(first.getTime() + 1_500),
    );
  });

  test("a failed stamp does not fail the log write, and the next use retries", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const recordUse = vi
      .spyOn(AgentUsageModel, "recordUse")
      .mockRejectedValueOnce(new Error("lock timeout"));

    const call = await createMcpCall(agent.id);
    await drainBackgroundWork();

    const [stored] = await db
      .select({ id: schema.mcpToolCallsTable.id })
      .from(schema.mcpToolCallsTable)
      .where(eq(schema.mcpToolCallsTable.id, call.id));
    expect(stored?.id).toBe(call.id);
    expect((await usageOf(agent.id)).lastUsedAt).toBeNull();

    // The failure clears the throttle, so a use right after it is stamped.
    const retry = await createInteraction(agent.id);
    await drainBackgroundWork();
    expect(recordUse).toHaveBeenCalledTimes(2);
    expect((await usageOf(agent.id)).lastUsedAt).toEqual(retry.createdAt);
    recordUse.mockRestore();
  });
});
