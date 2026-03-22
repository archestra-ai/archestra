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

describe("Agent Schedule Trigger Routes", () => {
  const orgId = "org-routes-test";
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

  test("Run-now enqueues task correctly", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/agent-schedule-triggers/${triggerId}/run-now`,
    });
    expect(response.statusCode).toBe(201);
    const tasks = await db.select().from(schema.tasksTable);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskType).toBe("schedule_trigger_run_execute");
  });
});
