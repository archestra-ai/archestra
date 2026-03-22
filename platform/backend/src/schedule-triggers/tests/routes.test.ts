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
import { scheduleTriggersTable } from "../models/schedule-trigger";
import { scheduleTriggerRunsTable } from "../models/schedule-trigger-run";
import { scheduleTriggerRoutes } from "../routes/schedule-trigger";

describe("Schedule Trigger Routes", () => {
  const orgId = "org-routes-test";
  let userId: string;
  let agentId: string;
  let triggerId: string;

  const buildApp = () => {
    const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    // Mock authentication middleware
    app.addHook("preHandler", async (request) => {
      (request as any).user = { id: userId, organizationId: orgId };
    });

    app.register(scheduleTriggerRoutes, { prefix: "/api/schedule-triggers" });
    return app;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    await db.delete(scheduleTriggerRunsTable);
    await db.delete(scheduleTriggersTable);
    await db.delete(schema.tasksTable);
    await UserModel.deleteMany({});
    await AgentModel.deleteMany({});

    const user = await UserModel.create({
      organizationId: orgId,
      name: "Test User",
      email: "test@example.com",
    });
    userId = user.id;

    const agent = await AgentModel.create({
      organizationId: orgId,
      name: "Test Agent",
      authorId: userId,
      scope: "personal",
    });
    agentId = agent.id;

    const [trigger] = await db
      .insert(scheduleTriggersTable)
      .values({
        organizationId: orgId,
        agentId,
        name: "Test Trigger",
        messageTemplate: "Run now!",
        cronExpression: "* * * * *",
        timezone: "UTC",
        enabled: true,
        actorUserId: userId,
      })
      .returning();
    triggerId = trigger.id;
  });

  test("5. Run-now endpoint creates and enqueues run", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/schedule-triggers/${triggerId}/run-now`,
    });

    expect(response.statusCode).toBe(201);
    const run = response.json();
    expect(run.runKind).toBe("manual");
    expect(run.status).toBe("pending");
    expect(run.agentIdSnapshot).toBe(agentId);

    // Verify it enqueued task
    const tasks = await db.select().from(schema.tasksTable);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskType).toBe("schedule_trigger_run_execute");
    expect((tasks[0].payload as any).runId).toBe(run.id);
  });

  test("6. Snapshot immutability (trigger update does not affect past runs)", async () => {
    const app = buildApp();

    // 1. Create a run from the initial trigger state
    const runResponse = await app.inject({
      method: "POST",
      url: `/api/schedule-triggers/${triggerId}/run-now`,
    });
    expect(runResponse.statusCode).toBe(201);
    const runId = runResponse.json().id;

    // 2. Update the trigger
    const updateResponse = await app.inject({
      method: "PUT",
      url: `/api/schedule-triggers/${triggerId}`,
      payload: {
        messageTemplate: "Updated message!",
      },
    });
    expect(updateResponse.statusCode).toBe(200);

    // 3. Verify the existing run STILL has the old snapshot
    const [run] = await db
      .select()
      .from(scheduleTriggerRunsTable)
      .where({ id: runId });
    expect(run.messageTemplateSnapshot).toBe("Run now!"); // Did not change

    // 4. Create a new run and verify it gets the updated snapshot
    const newRunResponse = await app.inject({
      method: "POST",
      url: `/api/schedule-triggers/${triggerId}/run-now`,
    });
    expect(newRunResponse.statusCode).toBe(201);

    const [newRun] = await db
      .select()
      .from(scheduleTriggerRunsTable)
      .where({ id: newRunResponse.json().id });
    expect(newRun.messageTemplateSnapshot).toBe("Updated message!");
  });
});
