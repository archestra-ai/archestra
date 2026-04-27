// biome-ignore-all lint/suspicious/noExplicitAny: test

import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { MemoryItemModel } from "@/models";
import MemoryTombstoneModel from "@/models/memory-tombstone";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

const t = (name: string) =>
  `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${name}`;

describe("memory MCP tools", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;
  let userId: string;
  let organizationId: string;

  beforeEach(async ({ makeAgent, makeMember, makeOrganization, makeUser }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    testAgent = await makeAgent({ name: "Memory Test Agent" });
    userId = user.id;
    organizationId = org.id;
    mockContext = {
      agent: { id: testAgent.id, name: testAgent.name },
      userId,
      organizationId,
    };
  });

  test("list_my_memory returns only approved user-scope memory for current user", async ({
    makeUser,
  }) => {
    const otherUser = await makeUser();

    await MemoryItemModel.create({
      organizationId,
      scopeType: "user",
      scopeId: userId,
      kind: "preference",
      status: "approved",
      content: "I prefer concise responses.",
      createdBy: userId,
      policyFlags: [],
    });
    await MemoryItemModel.create({
      organizationId,
      scopeType: "user",
      scopeId: userId,
      kind: "profile_fact",
      status: "candidate",
      content: "Candidate memory should not be listed.",
      createdBy: userId,
      policyFlags: [],
    });
    await MemoryItemModel.create({
      organizationId,
      scopeType: "team",
      scopeId: crypto.randomUUID(),
      kind: "team_convention",
      status: "approved",
      content: "Team scope memory should not be listed.",
      createdBy: userId,
      policyFlags: [],
    });
    await MemoryItemModel.create({
      organizationId,
      scopeType: "user",
      scopeId: otherUser.id,
      kind: "preference",
      status: "approved",
      content: "Other user's memory should not be listed.",
      createdBy: otherUser.id,
      policyFlags: [],
    });

    const result = await executeArchestraTool(
      t("list_my_memory"),
      {},
      mockContext,
    );

    expect(result.isError).toBe(false);
    const memoryItems = (result.structuredContent as any).memoryItems as Array<{
      scopeType: string;
      scopeId: string;
      status: string;
      content: string;
    }>;
    expect(memoryItems).toHaveLength(1);
    expect(memoryItems[0]).toMatchObject({
      scopeType: "user",
      scopeId: userId,
      status: "approved",
      content: "I prefer concise responses.",
    });
  });

  test("propose_memory_candidate creates candidate-only user memory", async () => {
    const result = await executeArchestraTool(
      t("propose_memory_candidate"),
      {
        kind: "instruction",
        content: "Answer in a concise style.",
      },
      mockContext,
    );

    expect(result.isError).toBe(false);
    const memoryItem = (result.structuredContent as any).memoryItem as {
      id: string;
      scopeType: string;
      scopeId: string;
      status: string;
      kind: string;
      content: string;
      sourceType: string | null;
      sourceId: string | null;
    };
    expect(memoryItem).toMatchObject({
      scopeType: "user",
      scopeId: userId,
      status: "candidate",
      kind: "instruction",
      content: "Answer in a concise style.",
      sourceType: "mcp_tool",
    });
    expect(memoryItem.sourceId).toContain("mcp:");

    const persisted = await MemoryItemModel.getById({
      id: memoryItem.id,
      organizationId,
    });
    expect(persisted?.status).toBe("candidate");
    expect(persisted?.scopeType).toBe("user");
    expect(persisted?.scopeId).toBe(userId);
    expect(persisted?.sourceType).toBe("mcp_tool");
    expect(persisted?.sourceMetadata).not.toBeNull();
  });

  test("propose_memory_candidate hard-blocks secret markers", async () => {
    const result = await executeArchestraTool(
      t("propose_memory_candidate"),
      {
        kind: "profile_fact",
        content: "My key is sk-abcdefghijklmnopqrstuvwxyz123456",
      },
      mockContext,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("blocked by policy");
  });

  test("propose_memory_candidate hard-blocks external context markers", async () => {
    const result = await executeArchestraTool(
      t("propose_memory_candidate"),
      {
        kind: "profile_fact",
        content:
          "UnsafeContextBoundary detected with external_context payload from a remote source.",
      },
      mockContext,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "external context markers",
    );
  });

  test("propose_memory_candidate hard-blocks normalized external marker variants", async () => {
    const result = await executeArchestraTool(
      t("propose_memory_candidate"),
      {
        kind: "profile_fact",
        content:
          "Received UNSAFE   CONTEXT   BOUNDARY metadata from TOOL RESULT payload.",
      },
      mockContext,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("blocked by policy");
  });

  test("propose_memory_candidate blocks tombstoned content re-proposal", async () => {
    const content = "Never persist this manipulative instruction again.";
    await MemoryTombstoneModel.record({
      organizationId,
      scopeType: "user",
      scopeId: userId,
      content,
      reason: "rejected",
    });

    const result = await executeArchestraTool(
      t("propose_memory_candidate"),
      {
        kind: "instruction",
        content,
      },
      mockContext,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("tombstoned");
  });

  test("propose_memory_candidate rejects unexpected payload shape", async () => {
    const result = await executeArchestraTool(
      t("propose_memory_candidate"),
      {
        kind: "preference",
        content: "I like markdown tables.",
        scopeType: "team",
      },
      mockContext,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "Validation error in archestra__propose_memory_candidate",
    );
  });
});
