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
import { scheduleTriggersTable } from "../models/schedule-trigger";
import { scheduleTriggerRunsTable } from "../models/schedule-trigger-run";
import {
  calculateNextDueAt,
  isValidTimezone,
  normalizeCronExpression,
  normalizeTimezone,
} from "../scheduler/utils";

const ScheduleTriggerSchema = z.object({
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

const ScheduleTriggerRunSchema = z.object({
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

export const scheduleTriggerRoutes: FastifyPluginAsyncZod = async (fastify) => {
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
      const {
        agentId,
        name,
        messageTemplate,
        cronExpression,
        timezone,
        enabled,
      } = request.body;
      const user = request.user!;

      const agent = await AgentModel.get(agentId);
      if (!agent || agent.organizationId !== user.organizationId) {
        return reply.status(404).send({ error: "Agent not found" });
      }
      if (agent.scope === "personal" && agent.authorId !== user.id) {
        return reply
          .status(403)
          .send({ error: "Cannot schedule personal agent owned by others" });
      }

      const tz = normalizeTimezone(timezone);
      if (!isValidTimezone(tz)) {
        return reply.status(400).send({ error: "Invalid timezone" });
      }

      const cron = normalizeCronExpression(cronExpression);
      const nextDueAt = calculateNextDueAt(cron, tz);

      if (!nextDueAt && enabled) {
        return reply.status(400).send({ error: "Invalid cron expression" });
      }

      const [trigger] = await db
        .insert(scheduleTriggersTable)
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
        response: {
          200: createPaginatedResponseSchema(ScheduleTriggerSchema as any),
        },
      },
    },
    async (request, reply) => {
      const { limit, offset } = request.query;
      const user = request.user!;

      const baseQuery = db
        .select()
        .from(scheduleTriggersTable)
        .where(eq(scheduleTriggersTable.organizationId, user.organizationId));

      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(scheduleTriggersTable)
        .where(eq(scheduleTriggersTable.organizationId, user.organizationId));

      const triggers = await applyPagination(baseQuery, {
        limit,
        offset,
      }).orderBy(desc(scheduleTriggersTable.createdAt));

      return {
        data: triggers,
        pagination: calculatePaginationMeta({ limit, offset }, count),
      };
    },
  );

  // GET
  fastify.get(
    "/:id",
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const [trigger] = await db
        .select()
        .from(scheduleTriggersTable)
        .where(
          and(
            eq(scheduleTriggersTable.id, request.params.id),
            eq(scheduleTriggersTable.organizationId, user.organizationId),
          ),
        );

      if (!trigger) {
        return reply.status(404).send({ error: "Not found" });
      }

      return trigger;
    },
  );

  // UPDATE
  fastify.put(
    "/:id",
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          name: z.string().min(1).optional(),
          messageTemplate: z.string().min(1).optional(),
          cronExpression: z.string().optional(),
          timezone: z.string().optional(),
          enabled: z.boolean().optional(),
        }),
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const triggerId = request.params.id;

      const [existing] = await db
        .select()
        .from(scheduleTriggersTable)
        .where(
          and(
            eq(scheduleTriggersTable.id, triggerId),
            eq(scheduleTriggersTable.organizationId, user.organizationId),
          ),
        );

      if (!existing) {
        return reply.status(404).send({ error: "Not found" });
      }

      const updates: any = { updatedAt: new Date() };

      if (request.body.name !== undefined) updates.name = request.body.name;
      if (request.body.messageTemplate !== undefined)
        updates.messageTemplate = request.body.messageTemplate;

      let newCron = existing.cronExpression;
      let newTz = existing.timezone;
      let scheduleChanged = false;

      if (request.body.cronExpression !== undefined) {
        newCron = normalizeCronExpression(request.body.cronExpression);
        scheduleChanged = true;
      }
      if (request.body.timezone !== undefined) {
        newTz = normalizeTimezone(request.body.timezone);
        if (!isValidTimezone(newTz))
          return reply.status(400).send({ error: "Invalid timezone" });
        scheduleChanged = true;
      }

      updates.cronExpression = newCron;
      updates.timezone = newTz;

      const willBeEnabled =
        request.body.enabled !== undefined
          ? request.body.enabled
          : existing.enabled;
      updates.enabled = willBeEnabled;

      if (willBeEnabled && (scheduleChanged || !existing.enabled)) {
        const nextDueAt = calculateNextDueAt(newCron, newTz);
        if (!nextDueAt)
          return reply.status(400).send({ error: "Invalid cron expression" });
        updates.nextDueAt = nextDueAt;
      } else if (!willBeEnabled) {
        updates.nextDueAt = null;
      }

      const [updated] = await db
        .update(scheduleTriggersTable)
        .set(updates)
        .where(eq(scheduleTriggersTable.id, triggerId))
        .returning();

      return updated;
    },
  );

  // DELETE
  fastify.delete(
    "/:id",
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const [deleted] = await db
        .delete(scheduleTriggersTable)
        .where(
          and(
            eq(scheduleTriggersTable.id, request.params.id),
            eq(scheduleTriggersTable.organizationId, user.organizationId),
          ),
        )
        .returning();

      if (!deleted) {
        return reply.status(404).send({ error: "Not found" });
      }

      return reply.status(204).send();
    },
  );

  // RUN NOW
  fastify.post(
    "/:id/run-now",
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const triggerId = request.params.id;

      const [trigger] = await db
        .select()
        .from(scheduleTriggersTable)
        .where(
          and(
            eq(scheduleTriggersTable.id, triggerId),
            eq(scheduleTriggersTable.organizationId, user.organizationId),
          ),
        );

      if (!trigger) {
        return reply.status(404).send({ error: "Not found" });
      }

      const run = await db.transaction(async (tx) => {
        const [newRun] = await tx
          .insert(scheduleTriggerRunsTable)
          .values({
            triggerId: trigger.id,
            organizationId: trigger.organizationId,
            runKind: "manual",
            status: "pending",
            dueAt: new Date(), // Manual runs effectively "due" now
            agentIdSnapshot: trigger.agentId,
            messageTemplateSnapshot: trigger.messageTemplate,
            actorUserIdSnapshot: trigger.actorUserId,
            cronExpressionSnapshot: trigger.cronExpression,
            timezoneSnapshot: trigger.timezone,
          })
          .returning();

        await tx.insert(schema.tasksTable).values({
          taskType: "schedule_trigger_run_execute" as TaskType,
          payload: { runId: newRun.id },
          maxAttempts: 1, // Manual runs just get 1 attempt and fail fast
        });

        return newRun;
      });

      return reply.status(201).send(run);
    },
  );

  // LIST RUNS
  fastify.get(
    "/:id/runs",
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        querystring: PaginationQuerySchema,
        response: {
          200: createPaginatedResponseSchema(ScheduleTriggerRunSchema as any),
        },
      },
    },
    async (request, reply) => {
      const { limit, offset } = request.query;
      const user = request.user!;
      const triggerId = request.params.id;

      const [trigger] = await db
        .select({ id: scheduleTriggersTable.id })
        .from(scheduleTriggersTable)
        .where(
          and(
            eq(scheduleTriggersTable.id, triggerId),
            eq(scheduleTriggersTable.organizationId, user.organizationId),
          ),
        );

      if (!trigger) {
        return reply.status(404).send({ error: "Not found" });
      }

      const baseQuery = db
        .select()
        .from(scheduleTriggerRunsTable)
        .where(eq(scheduleTriggerRunsTable.triggerId, triggerId));

      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(scheduleTriggerRunsTable)
        .where(eq(scheduleTriggerRunsTable.triggerId, triggerId));

      const runs = await applyPagination(baseQuery, { limit, offset }).orderBy(
        desc(scheduleTriggerRunsTable.createdAt),
      );

      return {
        data: runs,
        pagination: calculatePaginationMeta({ limit, offset }, count),
      };
    },
  );
};
export default scheduleTriggerRoutes;
