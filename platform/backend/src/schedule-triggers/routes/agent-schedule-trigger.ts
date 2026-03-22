import {
  PaginationQuerySchema,
  calculatePaginationMeta,
  createPaginatedResponseSchema,
} from "@shared";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { userHasPermission } from "@/auth";
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
  cronExpression: z.string().nullable(),
  intervalSeconds: z.number().nullable(),
  runAt: z.union([z.string(), z.date()]).nullable(),
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
  initiatedByUserId: z.string().nullable(),
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
  // Helpers
  const checkPermission = async (reply: any, userId: string, orgId: string, action: "read" | "create" | "update" | "delete") => {
    const allowed = await userHasPermission(userId, orgId, "agentTrigger", action);
    if (!allowed) {
        reply.status(403).send({ error: `Forbidden: Missing agentTrigger:${action}` });
        return false;
    }
    return true;
  };

  const validateAgentAccess = async (agentId: string, userId: string, orgId: string) => {
    const agent = await AgentModel.get(agentId);
    if (!agent || agent.organizationId !== orgId) return null;
    if (agent.scope === "personal" && agent.authorId !== userId) return null;
    return agent;
  };

  // CREATE
  fastify.post(
    "/",
    {
      schema: {
        body: z.object({
          agentId: z.string().uuid(),
          name: z.string().min(1),
          messageTemplate: z.string().min(1),
          scheduleKind: z.enum(["cron", "interval", "one-time"]),
          cronExpression: z.string().optional(),
          intervalSeconds: z.number().int().positive().optional(),
          runAt: z.string().datetime().optional(),
          timezone: z.string().optional(),
          enabled: z.boolean().default(true),
        }),
      },
    },
    async (request, reply) => {
      const user = request.user!;
      if (!await checkPermission(reply, user.id, user.organizationId, "create")) return;

      const agent = await validateAgentAccess(request.body.agentId, user.id, user.organizationId);
      if (!agent) return reply.status(404).send({ error: "Agent not found" });

      const tz = normalizeTimezone(request.body.timezone);
      if (!isValidTimezone(tz)) return reply.status(400).send({ error: "Invalid timezone" });

      const cron = request.body.cronExpression ? normalizeCronExpression(request.body.cronExpression) : null;
      const runAt = request.body.runAt ? new Date(request.body.runAt) : null;

      const nextDueAt = calculateNextDueAt({
        scheduleKind: request.body.scheduleKind,
        cronExpression: cron,
        intervalSeconds: request.body.intervalSeconds,
        runAt,
        timezone: tz,
      });

      if (!nextDueAt && request.body.enabled) return reply.status(400).send({ error: "Invalid schedule configuration" });

      const [trigger] = await db
        .insert(agentScheduleTriggersTable)
        .values({
          organizationId: user.organizationId,
          agentId: request.body.agentId,
          name: request.body.name,
          messageTemplate: request.body.messageTemplate,
          scheduleKind: request.body.scheduleKind,
          cronExpression: cron,
          intervalSeconds: request.body.intervalSeconds,
          runAt,
          timezone: tz,
          enabled: request.body.enabled,
          actorUserId: user.id,
          nextDueAt: request.body.enabled ? nextDueAt : null,
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
      if (!await checkPermission(reply, user.id, user.organizationId, "read")) return;

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
      if (!await checkPermission(reply, user.id, user.organizationId, "read")) return;

      const [trigger] = await db.select().from(agentScheduleTriggersTable).where(and(eq(agentScheduleTriggersTable.id, (request.params as any).id), eq(agentScheduleTriggersTable.organizationId, user.organizationId)));
      if (!trigger) return reply.status(404).send({ error: "Not found" });

      return trigger;
    },
  );

  // ENABLE/DISABLE
  fastify.post("/:id/enable", async (request, reply) => {
      const user = request.user!;
      if (!await checkPermission(reply, user.id, user.organizationId, "update")) return;

      const triggerId = (request.params as any).id;
      const [existing] = await db.select().from(agentScheduleTriggersTable).where(and(eq(agentScheduleTriggersTable.id, triggerId), eq(agentScheduleTriggersTable.organizationId, user.organizationId)));
      if (!existing) return reply.status(404).send({ error: "Not found" });

      const nextDueAt = calculateNextDueAt(existing);
      await db.update(agentScheduleTriggersTable).set({ enabled: true, nextDueAt, updatedAt: new Date() }).where(eq(agentScheduleTriggersTable.id, triggerId));
      return reply.status(204).send();
  });

  fastify.post("/:id/disable", async (request, reply) => {
      const user = request.user!;
      if (!await checkPermission(reply, user.id, user.organizationId, "update")) return;

      const triggerId = (request.params as any).id;
      await db.update(agentScheduleTriggersTable).set({ enabled: false, nextDueAt: null, updatedAt: new Date() }).where(and(eq(agentScheduleTriggersTable.id, triggerId), eq(agentScheduleTriggersTable.organizationId, user.organizationId)));
      return reply.status(204).send();
  });

  // STATS
  fastify.get("/stats", async (request, reply) => {
      const user = request.user!;
      if (!await checkPermission(reply, user.id, user.organizationId, "read")) return;

      const [{ enabledCount }] = await db.select({ enabledCount: sql<number>`count(*)::int` }).from(agentScheduleTriggersTable).where(and(eq(agentScheduleTriggersTable.organizationId, user.organizationId), eq(agentScheduleTriggersTable.enabled, true)));
      const [{ failedRuns24h }] = await db.select({ failedRuns24h: sql<number>`count(*)::int` }).from(agentScheduleTriggerRunsTable).where(and(eq(agentScheduleTriggerRunsTable.organizationId, user.organizationId), eq(agentScheduleTriggerRunsTable.status, "failed"), sql`created_at > now() - interval '24 hours'`));

      return { enabledCount, failedRuns24h };
  });

  // RUN NOW
  fastify.post(
    "/:id/run-now",
    async (request, reply) => {
      const user = request.user!;
      if (!await checkPermission(reply, user.id, user.organizationId, "update")) return;

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
            initiatedByUserId: user.id,
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

         // Update metadata on parent trigger
         await tx.update(agentScheduleTriggersTable).set({ lastRunAt: new Date(), lastRunStatus: "pending" }).where(eq(agentScheduleTriggersTable.id, triggerId));

         return newRun;
      });

      return reply.status(201).send(run);
    }
  );

  // LIST RUNS
  fastify.get(
    "/:id/runs",
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        querystring: PaginationQuerySchema.extend({
            status: z.enum(["pending", "running", "success", "failed"]).optional(),
        }),
        response: { 200: createPaginatedResponseSchema(AgentScheduleTriggerRunSchema as any) },
      },
    },
    async (request, reply) => {
      const { limit, offset, status } = request.query;
      const triggerId = request.params.id;
      const user = request.user!;
      if (!await checkPermission(reply, user.id, user.organizationId, "read")) return;

      let baseQuery = db.select().from(agentScheduleTriggerRunsTable).where(and(eq(agentScheduleTriggerRunsTable.triggerId, triggerId), eq(agentScheduleTriggerRunsTable.organizationId, user.organizationId)));
      if (status) {
          baseQuery = baseQuery.where(eq(agentScheduleTriggerRunsTable.status, status)) as any;
      }

      const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(agentScheduleTriggerRunsTable).where(and(eq(agentScheduleTriggerRunsTable.triggerId, triggerId), eq(agentScheduleTriggerRunsTable.organizationId, user.organizationId), status ? eq(agentScheduleTriggerRunsTable.status, status) : sql`1=1`));

      const data = await applyPagination(baseQuery, { limit, offset }).orderBy(desc(agentScheduleTriggerRunsTable.createdAt));
      return { data, pagination: calculatePaginationMeta({ limit, offset }, count) };
    }
  );
};
export default agentScheduleTriggerRoutes;
