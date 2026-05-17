// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

const TOOL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_scheduled_task`;

describe("create_scheduled_task tool execution", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;

  beforeEach(
    async ({ makeInternalAgent, makeUser, makeOrganization, makeMember }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "admin" });
      testAgent = await makeInternalAgent({
        name: "Test Agent",
        organizationId: org.id,
      });
      mockContext = {
        agent: { id: testAgent.id, name: testAgent.name },
        agentId: testAgent.id,
        userId: user.id,
        organizationId: org.id,
      };
    },
  );

  test("creates a scheduled task using the current chat's agent by default", async () => {
    const result = await executeArchestraTool(
      TOOL_NAME,
      {
        name: "Daily standup reminder",
        messageTemplate: "Remind me to attend the daily standup.",
        cronExpression: "0 9 * * 1-5",
        timezone: "America/New_York",
      },
      mockContext,
    );

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.success).toBe(true);
    expect(structured.agentId).toBe(testAgent.id);
    expect(structured.name).toBe("Daily standup reminder");
    expect(structured.cronExpression).toBe("0 9 * * 1-5");
    expect(structured.timezone).toBe("America/New_York");
    expect(typeof structured.scheduleTriggerId).toBe("string");
  });

  test("rejects an invalid cron expression with a useful message", async () => {
    const result = await executeArchestraTool(
      TOOL_NAME,
      {
        name: "Bad cron",
        messageTemplate: "Run something.",
        cronExpression: "not a cron",
        timezone: "UTC",
      },
      mockContext,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "Validation error in archestra__create_scheduled_task",
    );
    expect((result.content[0] as any).text.toLowerCase()).toContain("cron");
  });

  test("rejects an invalid IANA timezone", async () => {
    const result = await executeArchestraTool(
      TOOL_NAME,
      {
        name: "Bad tz",
        messageTemplate: "Run something.",
        cronExpression: "0 9 * * *",
        timezone: "Not/AReal_Zone",
      },
      mockContext,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text.toLowerCase()).toContain("timezone");
  });

  test("requires a logged-in user context", async () => {
    const result = await executeArchestraTool(
      TOOL_NAME,
      {
        name: "Anon attempt",
        messageTemplate: "Anything.",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
      },
      {
        agent: { id: testAgent.id, name: testAgent.name },
        agentId: testAgent.id,
      },
    );

    // No userId → centralized RBAC denies before the handler runs.
    expect(result.isError).toBe(true);
  });

  test("rejects when the target agent does not exist", async () => {
    const result = await executeArchestraTool(
      TOOL_NAME,
      {
        name: "Bogus agent",
        messageTemplate: "Anything.",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        agentId: "00000000-0000-0000-0000-000000000000",
      },
      mockContext,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text.toLowerCase()).toContain("agent");
  });
});
