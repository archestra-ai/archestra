// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

const TOOL = (name: string) =>
  `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${name}`;
const CREATE = TOOL("create_scheduled_task");
const LIST = TOOL("list_scheduled_tasks");
const UPDATE = TOOL("update_scheduled_task");
const DELETE = TOOL("delete_scheduled_task");

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
      CREATE,
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
      CREATE,
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
      CREATE,
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
      CREATE,
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
      CREATE,
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

describe("list_scheduled_tasks tool execution", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;
  let organizationId: string;

  beforeEach(
    async ({ makeInternalAgent, makeUser, makeOrganization, makeMember }) => {
      const org = await makeOrganization();
      organizationId = org.id;
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

  async function createTask(name: string, cron = "0 9 * * *") {
    const result = await executeArchestraTool(
      CREATE,
      {
        name,
        messageTemplate: `Run ${name}.`,
        cronExpression: cron,
        timezone: "UTC",
      },
      mockContext,
    );
    expect(result.isError).toBeFalsy();
    return (result.structuredContent as { scheduleTriggerId: string })
      .scheduleTriggerId;
  }

  test("returns empty list when the user has no tasks", async () => {
    const result = await executeArchestraTool(LIST, {}, mockContext);
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.total).toBe(0);
    expect(structured.tasks).toEqual([]);
  });

  test("returns the user's tasks", async () => {
    await createTask("Alpha task");
    await createTask("Beta task");

    const result = await executeArchestraTool(LIST, {}, mockContext);
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      total: number;
      tasks: any[];
    };
    expect(structured.total).toBe(2);
    expect(structured.tasks.map((t) => t.name).sort()).toEqual([
      "Alpha task",
      "Beta task",
    ]);
  });

  test("filters by name (case-insensitive substring)", async () => {
    await createTask("Daily shave reminder");
    await createTask("Weekly summary email");

    const result = await executeArchestraTool(
      LIST,
      { name: "shave" },
      mockContext,
    );
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      total: number;
      tasks: any[];
    };
    expect(structured.total).toBe(1);
    expect(structured.tasks[0].name).toBe("Daily shave reminder");
  });

  test("does not include other users' tasks by default", async ({
    makeMember,
    makeUser,
  }) => {
    await createTask("Caller task");

    const otherUser = await makeUser();
    await makeMember(otherUser.id, organizationId, {
      role: "admin",
    });
    const otherResult = await executeArchestraTool(
      CREATE,
      {
        name: "Other user task",
        messageTemplate: "Run other task.",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
      },
      {
        ...mockContext,
        userId: otherUser.id,
      },
    );
    expect(otherResult.isError).toBeFalsy();

    const result = await executeArchestraTool(LIST, {}, mockContext);
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      total: number;
      tasks: any[];
    };
    expect(structured.total).toBe(1);
    expect(structured.tasks.map((t) => t.name)).toEqual(["Caller task"]);
  });
});

describe("update_scheduled_task tool execution", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;
  let existingTaskId: string;

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

      const created = await executeArchestraTool(
        CREATE,
        {
          name: "Original name",
          messageTemplate: "Original message.",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
        },
        mockContext,
      );
      existingTaskId = (
        created.structuredContent as { scheduleTriggerId: string }
      ).scheduleTriggerId;
    },
  );

  test("updates the name and cron without touching unchanged fields", async () => {
    const result = await executeArchestraTool(
      UPDATE,
      {
        id: existingTaskId,
        name: "Renamed task",
        cronExpression: "30 8 * * *",
      },
      mockContext,
    );

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.name).toBe("Renamed task");
    expect(structured.cronExpression).toBe("30 8 * * *");
    expect(structured.timezone).toBe("UTC");
    expect(structured.messageTemplate).toBe("Original message.");
    expect(structured.enabled).toBe(true);
  });

  test("disables a task via enabled=false (pause)", async () => {
    const result = await executeArchestraTool(
      UPDATE,
      { id: existingTaskId, enabled: false },
      mockContext,
    );
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as Record<string, unknown>).enabled).toBe(
      false,
    );
  });

  test("rejects an update with no fields besides id", async () => {
    const result = await executeArchestraTool(
      UPDATE,
      { id: existingTaskId },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text.toLowerCase()).toContain(
      "at least one field",
    );
  });

  test("rejects an invalid new cron expression", async () => {
    const result = await executeArchestraTool(
      UPDATE,
      { id: existingTaskId, cronExpression: "not a cron" },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text.toLowerCase()).toContain("cron");
  });

  test("rejects updating a task belonging to a different user", async () => {
    // Build a second user/org-member combo and try to update the first
    // user's task from that context. Reuses the existing org so RBAC alone
    // gates access (non-admin foreign user).
    const result = await executeArchestraTool(
      UPDATE,
      { id: existingTaskId, name: "Hijack attempt" },
      {
        ...mockContext,
        // Pretend a different user is calling; non-admin and not the owner.
        userId: "00000000-0000-0000-0000-000000000999",
      },
    );
    expect(result.isError).toBe(true);
  });

  test("rejects retargeting a task to an agent the stored actor cannot access", async ({
    makeInternalAgent,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const actor = await makeUser();
    const admin = await makeUser();
    await makeMember(actor.id, org.id);
    await makeMember(admin.id, org.id, { role: "admin" });

    const sharedAgent = await makeInternalAgent({
      name: "Shared Agent",
      organizationId: org.id,
      scope: "org",
    });
    const adminPersonalAgent = await makeInternalAgent({
      name: "Admin Personal Agent",
      organizationId: org.id,
      scope: "personal",
      authorId: admin.id,
    });

    const created = await executeArchestraTool(
      CREATE,
      {
        name: "Actor task",
        messageTemplate: "Original message.",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
      },
      {
        agent: { id: sharedAgent.id, name: sharedAgent.name },
        agentId: sharedAgent.id,
        userId: actor.id,
        organizationId: org.id,
      },
    );
    expect(created.isError).toBeFalsy();
    const taskId = (created.structuredContent as { scheduleTriggerId: string })
      .scheduleTriggerId;

    const result = await executeArchestraTool(
      UPDATE,
      { id: taskId, agentId: adminPersonalAgent.id },
      {
        agent: { id: sharedAgent.id, name: sharedAgent.name },
        agentId: sharedAgent.id,
        userId: admin.id,
        organizationId: org.id,
      },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text.toLowerCase()).toContain(
      "stored task actor",
    );
  });
});

describe("delete_scheduled_task tool execution", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;
  let existingTaskId: string;

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

      const created = await executeArchestraTool(
        CREATE,
        {
          name: "Going to be deleted",
          messageTemplate: "Goodbye.",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
        },
        mockContext,
      );
      existingTaskId = (
        created.structuredContent as { scheduleTriggerId: string }
      ).scheduleTriggerId;
    },
  );

  test("deletes an owned task", async () => {
    const result = await executeArchestraTool(
      DELETE,
      { id: existingTaskId },
      mockContext,
    );
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.success).toBe(true);
    // Output includes a snapshot of the deleted task so the chat UI can show
    // a confirmation card after the row is gone.
    expect(structured.id).toBe(existingTaskId);
    expect(structured.name).toBe("Going to be deleted");
    expect(typeof structured.agentId).toBe("string");
    expect(structured.cronExpression).toBe("0 9 * * *");
    expect(structured.timezone).toBe("UTC");

    // List should now be empty.
    const list = await executeArchestraTool(LIST, {}, mockContext);
    expect((list.structuredContent as { total: number }).total).toBe(0);
  });

  test("returns not-found for a nonexistent id", async () => {
    // Use a UUID that won't exist in the freshly-truncated test DB.
    const result = await executeArchestraTool(
      DELETE,
      { id: "11111111-2222-4333-8444-555555555555" },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text.toLowerCase()).toContain(
      "not found",
    );
  });
});
