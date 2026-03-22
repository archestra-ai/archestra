import {
  PaginationQuerySchema,
  calculatePaginationMeta,
  createPaginatedResponseSchema,
} from "@shared";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import db, { schema } from "@/database";
import { applyPagination } from "@/database/utils/pagination";
import { AgentModel } from "@/models";
import type { TaskType } from "@/types";
import { agentScheduleTriggersTable } from "../models/agent-schedule-trigger";
import { agentScheduleTriggerRunsTable } from "../models/agent-schedule-trigger-run";
import {
  calculateNextDueAt,
  isValidTimezone,
  normalizeCronExpression,
  normalizeTimezone,
} from "../scheduler/utils";

const AgentScheduleTriggerSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string(),
  agentId: z.string(),
  name: z.string(),
  messageTemplate: z.string(),
  scheduleKind: z.string(),
  cronExpression: z.string(),
  timezone: z.string(),
  enabled: z.boolean(),
  actorUserId: z.string(),
  nextDueAt: z.union([z.string(), z.date()]).nullable(),
  lastRunAt: z.union([z.string(), z.date()]).nullable(),
  lastRunStatus: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.union([z.string(), z.date()]),
  updatedAt: z.union([z.string(), z.date()]),
});

const AgentScheduleTriggerRunSchema = z.object({
  id: z.string().uuid(),
  triggerId: z.string().uuid(),
  organizationId: z.string(),
  runKind: z.string(),
  status: z.string(),
  dueAt: z.union([z.string(), z.date()]).nullable(),
  startedAt: z.union([z.string(), z.date()]).nullable(),
  completedAt: z.union([z.string(), z.date()]).nullable(),
  error: z.string().nullable(),
  agentIdSnapshot: z.string(),
  messageTemplateSnapshot: z.string(),
  actorUserIdSnapshot: z.string(),
  cronExpressionSnapshot: z.string().nullable(),
  timezoneSnapshot: z.string().nullable(),
  createdAt: z.union([z.string(), z.date()]),
});

export const agentScheduleTriggerRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // CREATE
  fastify.post(
    "/",
    {
      schema: {
        body: z.object({
          agentId: z.string().uuid(),
          name: z.string().min(1),
          messageTemplate: z.string().min(1),
          cronExpression: z.string(),
          timezone: z.string().optional(),
          enabled: z.boolean().default(true),
        }),
      },
    },
    async (request, reply) => {
      const { agentId, name, messageTemplate, cronExpression, timezone, enabled } = request.body;
      const user = request.user!;

      const agent = await AgentModel.get(agentId);
      if (!agent || agent.organizationId !== user.organizationId) {
        return reply.status(404).send({ error: "Agent not found" });
      }

      const tz = normalizeTimezone(timezone);
      if (!isValidTimezone(tz)) return reply.status(400).send({ error: "Invalid timezone" });

      const cron = normalizeCronExpression(cronExpression);
      const nextDueAt = calculateNextDueAt(cron, tz);

      if (!nextDueAt && enabled) return reply.status(400).send({ error: "Invalid cron" });

      const [trigger] = await db
        .insert(agentScheduleTriggersTable)
        .values({
          organizationId: user.organizationId,
          agentId,
          name,
          messageTemplate,
          cronExpression: cron,
          timezone: tz,
          enabled,
          actorUserId: user.id,
          nextDueAt: enabled ? nextDueAt : null,
        })
        .returning();

      return reply.status(201).send(trigger);
    },
  );

  // LIST
  fastify.get(
    "/",
    {
      schema: {
        querystring: PaginationQuerySchema,
        response: { 200: createPaginatedResponseSchema(AgentScheduleTriggerSchema as any) },
      },
    },
    async (request, reply) => {
      const { limit, offset } = request.query;
      const user = request.user!;

      const baseQuery = db.select().from(agentScheduleTriggersTable).where(eq(agentScheduleTriggersTable.organizationId, user.organizationId));
      const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(agentScheduleTriggersTable).where(eq(agentScheduleTriggersTable.organizationId, user.organizationId));

      const triggers = await applyPagination(baseQuery, { limit, offset }).orderBy(desc(agentScheduleTriggersTable.createdAt));
      return { data: triggers, pagination: calculatePaginationMeta({ limit, offset }, count) };
    },
  );

  // GET
  fastify.get(
    "/:id",
    async (request, reply) => {
      const user = request.user!;
      const [trigger] = await db.select().from(agentScheduleTriggersTable).where(and(eq(agentScheduleTriggersTable.id, (request.params as any).id), eq(agentScheduleTriggersTable.organizationId, user.organizationId)));
      if (!trigger) return reply.status(404).send({ error: "Not found" });
      return trigger;
    },
  );

  // UPDATE
  fastify.put(
    "/:id",
    async (request, reply) => {
      const user = request.user!;
      const triggerId = (request.params as any).id;
      const body = request.body as any;

      const [existing] = await db.select().from(agentScheduleTriggersTable).where(and(eq(agentScheduleTriggersTable.id, triggerId), eq(agentScheduleTriggersTable.organizationId, user.organizationId)));
      if (!existing) return reply.status(404).send({ error: "Not found" });

      const cron = body.cronExpression ? normalizeCronExpression(body.cronExpression) : existing.cronExpression;
      const tz = body.timezone ? normalizeTimezone(body.timezone) : existing.timezone;
      const enabled = body.enabled !== undefined ? body.enabled : existing.enabled;

      const nextDueAt = enabled ? calculateNextDueAt(cron, tz) : null;

      const [updated] = await db.update(agentScheduleTriggersTable).set({
        ...body,
        cronExpression: cron,
        timezone: tz,
        enabled,
        nextDueAt,
        updatedAt: new Date()
      }).where(eq(agentScheduleTriggersTable.id, triggerId)).returning();

      return updated;
    }
  );

  // DELETE
  fastify.delete("/:id", async (request, reply) => {
     const user = request.user!;
     await db.delete(agentScheduleTriggersTable).where(and(eq(agentScheduleTriggersTable.id, (request.params as any).id), eq(agentScheduleTriggersTable.organizationId, user.organizationId)));
     return reply.status(204).send();
  });

  // RUN NOW
  fastify.post(
    "/:id/run-now",
    async (request, reply) => {
      const user = request.user!;
      const triggerId = (request.params as any).id;

      const [trigger] = await db.select().from(agentScheduleTriggersTable).where(and(eq(agentScheduleTriggersTable.id, triggerId), eq(agentScheduleTriggersTable.organizationId, user.organizationId)));
      if (!trigger) return reply.status(404).send({ error: "Not found" });

      const run = await db.transaction(async (tx) => {
         const [newRun] = await tx.insert(agentScheduleTriggerRunsTable).values({
            triggerId: trigger.id,
            organizationId: trigger.organizationId,
            runKind: "manual",
            status: "pending",
            dueAt: new Date(),
            agentIdSnapshot: trigger.agentId,
            messageTemplateSnapshot: trigger.messageTemplate,
            actorUserIdSnapshot: trigger.actorUserId,
            cronExpressionSnapshot: trigger.cronExpression,
            timezoneSnapshot: trigger.timezone,
         }).returning();

         await tx.insert(schema.tasksTable).values({
            taskType: "schedule_trigger_run_execute" as TaskType,
            payload: { runId: newRun.id },
            maxAttempts: 1
         });
         return newRun;
      });

      return reply.status(201).send(run);
    }
  );

  // LIST RUNS
  fastify.get(
    "/:id/runs",
    async (request, reply) => {
      const { limit, offset } = request.query as any;
      const triggerId = (request.params as any).id;
      const user = request.user!;

      const [trigger] = await db.select().from(agentScheduleTriggersTable).where(and(eq(agentScheduleTriggersTable.id, triggerId), eq(agentScheduleTriggersTable.organizationId, user.organizationId)));
      if (!trigger) return reply.status(404).send({ error: "Not found" });

      const baseQuery = db.select().from(agentScheduleTriggerRunsTable).where(eq(agentScheduleTriggerRunsTable.triggerId, triggerId));
      const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(agentScheduleTriggerRunsTable).where(eq(agentScheduleTriggerRunsTable.triggerId, triggerId));

      const data = await applyPagination(baseQuery, { limit, offset }).orderBy(desc(agentScheduleTriggerRunsTable.createdAt));
      return { data, pagination: calculatePaginationMeta({ limit, offset }, count) };
    }
  );
};
export default agentScheduleTriggerRoutes;
