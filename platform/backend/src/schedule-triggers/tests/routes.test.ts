import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { AgentModel, UserModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import { agentScheduleTriggersTable } from "../models/agent-schedule-trigger";
import { agentScheduleTriggerRunsTable } from "../models/agent-schedule-trigger-run";
import { agentScheduleTriggerRoutes } from "../routes/agent-schedule-trigger";

// Mock permissions
vi.mock("@/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/auth")>();
  return {
    ...actual,
    userHasPermission: vi.fn().mockResolvedValue(true),
  };
});

import { userHasPermission } from "@/auth";

describe("Agent Schedule Trigger Routes (Robustness)", () => {
  const orgId = "org-robust-test";
  let userId: string;
  let agentId: string;
  let triggerId: string;

  const buildApp = () => {
    const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.addHook("preHandler", async (request) => {
      (request as any).user = { id: userId, organizationId: orgId };
    });
    app.register(agentScheduleTriggerRoutes, { prefix: "/api/agent-schedule-triggers" });
    return app;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(userHasPermission).mockResolvedValue(true);
    await db.delete(agentScheduleTriggerRunsTable);
    await db.delete(agentScheduleTriggersTable);
    await db.delete(schema.tasksTable);
    await UserModel.deleteMany({});
    await AgentModel.deleteMany({});

    const user = await UserModel.create({ organizationId: orgId, name: "Test User", email: "test@example.com" });
    userId = user.id;

    const agent = await AgentModel.create({ organizationId: orgId, name: "Test Agent", authorId: userId, scope: "personal" });
    agentId = agent.id;

    const [trigger] = await db.insert(agentScheduleTriggersTable).values({
        organizationId: orgId,
        agentId,
        name: "Test Trigger",
        messageTemplate: "Run now!",
        cronExpression: "* * * * *",
        timezone: "UTC",
        enabled: true,
        actorUserId: userId,
    }).returning();
    triggerId = trigger.id;
  });

  test("RBAC: Returns 403 Forbidden when permission is missing", async () => {
    vi.mocked(userHasPermission).mockResolvedValue(false);
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/agent-schedule-triggers",
      payload: { agentId, name: "New", messageTemplate: "Hi", scheduleKind: "cron", cronExpression: "* * * * *" }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toContain("Forbidden");
  });

  test("Manual: updates trigger metadata", async () => {
    const app = buildApp();
    await app.inject({
      method: "POST",
      url: `/api/agent-schedule-triggers/${triggerId}/run-now`,
    });
    
    const [trigger] = await db.select().from(agentScheduleTriggersTable).where({ id: triggerId });
    expect(trigger.lastRunStatus).toBe("pending");
    expect(trigger.lastRunAt).not.toBeNull();
  });

  test("Runs list: validates pagination", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "GET",
      url: `/api/agent-schedule-triggers/${triggerId}/runs`,
      query: { limit: "invalid" }
    });
    expect(response.statusCode).toBe(400); // Schema validation should fail
  });
});
