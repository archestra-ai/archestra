import {
  calculatePaginationMeta,
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  ConversationModel,
  ScheduleTriggerModel,
  ScheduleTriggerRunModel,
} from "@/models";
import { projectService } from "@/services/project";
import { ResourcePermissions } from "@/services/resource-permissions";
import {
  findAccessibleScheduleTriggerOrThrow,
  findAccessibleScheduleTriggerRunOrThrow,
  startManualScheduleTriggerRun,
} from "@/services/schedule-trigger-access";
import {
  createScheduleTrigger,
  updateScheduleTrigger,
} from "@/services/schedule-trigger-management";
import {
  backfillRunConversationMessages,
  createAndLinkRunConversation,
  ensureFailedRunErrorVisible,
} from "@/services/scheduled-run-conversation";
import {
  ApiError,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  ScheduleTriggerRunStatusSchema,
  SelectConversationSchema,
  SelectScheduleTriggerRunSchema,
  SelectScheduleTriggerSchema,
  UuidIdSchema,
} from "@/types";
import {
  CreateScheduleTriggerBodySchema,
  UpdateScheduleTriggerBodySchema,
} from "@/types/schedule-trigger-input";

const scheduleTriggerRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/schedule-triggers",
    {
      schema: {
        operationId: RouteId.GetScheduleTriggers,
        description: "List scheduled agent triggers",
        tags: ["Schedule Triggers"],
        querystring: PaginationQuerySchema.extend({
          enabled: z
            .preprocess(
              (value) =>
                value === undefined
                  ? undefined
                  : value === "true" || value === true,
              z.boolean(),
            )
            .optional(),
          name: z.string().optional(),
          actorUserIds: z.string().optional(),
          agentIds: z.string().optional(),
          projectId: z.string().uuid().optional(),
          showAll: z
            .preprocess(
              (value) =>
                value === undefined
                  ? undefined
                  : value === "true" || value === true,
              z.boolean(),
            )
            .optional(),
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(SelectScheduleTriggerSchema),
        ),
      },
    },
    async (
      {
        query: {
          limit,
          offset,
          enabled,
          name,
          actorUserIds: actorUserIdsParam,
          agentIds: agentIdsParam,
          projectId,
          showAll,
        },
        user,
        organizationId,
      },
      reply,
    ) => {
      // By default, filter to the current user's tasks
      let actorUserId: string | undefined = user.id;
      let actorUserIds: string[] | undefined;
      let excludeActorUserId: string | undefined;

      if (showAll) {
        const isScheduledTaskAdmin = await ResourcePermissions.allows({
          userId: user.id,
          organizationId,
          resource: "scheduledTask",
          scope: "*",
          action: "read",
        });
        if (isScheduledTaskAdmin) {
          actorUserId = undefined;
          if (actorUserIdsParam) {
            // Filter to specific users
            actorUserIds = actorUserIdsParam.split(",").filter(Boolean);
          } else {
            // Show all other users' tasks (exclude current user)
            excludeActorUserId = user.id;
          }
        }
      }

      const agentIds = agentIdsParam
        ? agentIdsParam.split(",").filter(Boolean)
        : undefined;

      // Project-scoped listing: project access is the authorization, so show
      // every member's schedules for the project, not just the requester's.
      if (projectId) {
        await projectService.get({
          id: projectId,
          organizationId,
          userId: user.id,
          // a project admin may see the project's schedules for oversight
          allowAdminOversight: true,
        });
        actorUserId = undefined;
        actorUserIds = undefined;
        excludeActorUserId = undefined;
      }

      const [data, total] = await Promise.all([
        ScheduleTriggerModel.listByOrganization({
          organizationId,
          limit,
          offset,
          enabled,
          agentIds,
          actorUserId,
          actorUserIds,
          excludeActorUserId,
          name,
          projectId,
        }),
        ScheduleTriggerModel.countByOrganization({
          organizationId,
          enabled,
          agentIds,
          actorUserId,
          actorUserIds,
          excludeActorUserId,
          name,
          projectId,
        }),
      ]);

      return reply.send({
        data,
        pagination: calculatePaginationMeta(total, { limit, offset }),
      });
    },
  );

  fastify.post(
    "/api/schedule-triggers",
    {
      schema: {
        operationId: RouteId.CreateScheduleTrigger,
        description: "Create a scheduled agent trigger",
        tags: ["Schedule Triggers"],
        body: CreateScheduleTriggerBodySchema,
        response: constructResponseSchema(SelectScheduleTriggerSchema),
      },
    },
    async ({ body, user, organizationId }, reply) => {
      const trigger = await createScheduleTrigger({
        body,
        userId: user.id,
        organizationId,
      });

      return reply.send(trigger);
    },
  );

  fastify.get(
    "/api/schedule-triggers/:id",
    {
      schema: {
        operationId: RouteId.GetScheduleTrigger,
        description: "Get a scheduled agent trigger",
        tags: ["Schedule Triggers"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(SelectScheduleTriggerSchema),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      const trigger = await findAccessibleScheduleTriggerOrThrow({
        id,
        userId: user.id,
        organizationId,
        access: "read",
      });

      return reply.send(trigger);
    },
  );

  fastify.put(
    "/api/schedule-triggers/:id",
    {
      schema: {
        operationId: RouteId.UpdateScheduleTrigger,
        description: "Update a scheduled agent trigger",
        tags: ["Schedule Triggers"],
        params: z.object({ id: UuidIdSchema }),
        body: UpdateScheduleTriggerBodySchema,
        response: constructResponseSchema(SelectScheduleTriggerSchema),
      },
    },
    async ({ params: { id }, body, user, organizationId }, reply) => {
      const updated = await updateScheduleTrigger({
        id,
        body,
        userId: user.id,
        organizationId,
      });

      return reply.send(updated);
    },
  );

  fastify.delete(
    "/api/schedule-triggers/:id",
    {
      schema: {
        operationId: RouteId.DeleteScheduleTrigger,
        description: "Delete a scheduled agent trigger",
        tags: ["Schedule Triggers"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      await findAccessibleScheduleTriggerOrThrow({
        id,
        userId: user.id,
        organizationId,
        access: "mutate",
      });

      const success = await ScheduleTriggerModel.delete(id);
      if (!success) {
        throw new ApiError(404, "Schedule trigger not found");
      }

      return reply.send({ success: true });
    },
  );

  fastify.post(
    "/api/schedule-triggers/:id/enable",
    {
      schema: {
        operationId: RouteId.EnableScheduleTrigger,
        description: "Enable a scheduled agent trigger",
        tags: ["Schedule Triggers"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(SelectScheduleTriggerSchema),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      await findAccessibleScheduleTriggerOrThrow({
        id,
        userId: user.id,
        organizationId,
        access: "mutate",
      });

      const updated = await ScheduleTriggerModel.update(id, {
        enabled: true,
      });

      if (!updated) {
        throw new ApiError(404, "Schedule trigger not found");
      }

      return reply.send(updated);
    },
  );

  fastify.post(
    "/api/schedule-triggers/:id/disable",
    {
      schema: {
        operationId: RouteId.DisableScheduleTrigger,
        description: "Disable a scheduled agent trigger",
        tags: ["Schedule Triggers"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(SelectScheduleTriggerSchema),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      await findAccessibleScheduleTriggerOrThrow({
        id,
        userId: user.id,
        organizationId,
        access: "mutate",
      });

      const updated = await ScheduleTriggerModel.update(id, {
        enabled: false,
      });

      if (!updated) {
        throw new ApiError(404, "Schedule trigger not found");
      }

      return reply.send(updated);
    },
  );

  fastify.post(
    "/api/schedule-triggers/:id/run-now",
    {
      schema: {
        operationId: RouteId.RunScheduleTriggerNow,
        description: "Run a scheduled agent trigger immediately",
        tags: ["Schedule Triggers"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(SelectScheduleTriggerRunSchema),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      const trigger = await findAccessibleScheduleTriggerOrThrow({
        id,
        userId: user.id,
        organizationId,
        access: "mutate",
      });

      const run = await startManualScheduleTriggerRun({
        trigger,
        initiatedByUserId: user.id,
      });

      return reply.send(run);
    },
  );

  fastify.get(
    "/api/schedule-triggers/:id/runs",
    {
      schema: {
        operationId: RouteId.GetScheduleTriggerRuns,
        description: "List runs for a scheduled agent trigger",
        tags: ["Schedule Triggers"],
        params: z.object({ id: UuidIdSchema }),
        querystring: PaginationQuerySchema.extend({
          status: ScheduleTriggerRunStatusSchema.optional(),
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(SelectScheduleTriggerRunSchema),
        ),
      },
    },
    async (
      {
        params: { id },
        query: { limit, offset, status },
        user,
        organizationId,
      },
      reply,
    ) => {
      const trigger = await findAccessibleScheduleTriggerOrThrow({
        id,
        userId: user.id,
        organizationId,
        access: "read",
      });

      const [data, total] = await Promise.all([
        ScheduleTriggerRunModel.listByTrigger({
          organizationId,
          triggerId: trigger.id,
          limit,
          offset,
          status,
        }),
        ScheduleTriggerRunModel.countByTrigger({
          organizationId,
          triggerId: trigger.id,
          status,
        }),
      ]);

      return reply.send({
        data,
        pagination: calculatePaginationMeta(total, { limit, offset }),
      });
    },
  );

  fastify.get(
    "/api/schedule-triggers/:id/runs/:runId",
    {
      schema: {
        operationId: RouteId.GetScheduleTriggerRun,
        description: "Get a single run for a scheduled agent trigger",
        tags: ["Schedule Triggers"],
        params: z.object({
          id: UuidIdSchema,
          runId: UuidIdSchema,
        }),
        response: constructResponseSchema(SelectScheduleTriggerRunSchema),
      },
    },
    async ({ params: { id, runId }, user, organizationId }, reply) => {
      const run = await findAccessibleScheduleTriggerRunOrThrow({
        triggerId: id,
        runId,
        userId: user.id,
        organizationId,
        access: "read",
      });

      return reply.send(run);
    },
  );

  fastify.post(
    "/api/schedule-triggers/:id/runs/:runId/conversation",
    {
      schema: {
        operationId: RouteId.CreateScheduleTriggerRunConversation,
        description:
          "Create or return the chat conversation linked to a schedule run",
        tags: ["Schedule Triggers"],
        params: z.object({
          id: UuidIdSchema,
          runId: UuidIdSchema,
        }),
        response: constructResponseSchema(SelectConversationSchema),
      },
    },
    async ({ params: { id, runId }, user, organizationId }, reply) => {
      // Access is owner / scheduledTask:admin (the shared run gate) — the
      // same gate as every other schedule op. Loading the run conversation can
      // MINT one when it isn't linked yet (createAndLinkRunConversation below),
      // so it stays on that existing permission rather than any project scope.
      const run = await findAccessibleScheduleTriggerRunOrThrow({
        triggerId: id,
        runId,
        userId: user.id,
        organizationId,
        access: "mutate",
      });

      const conversation = await ensureRunConversation({
        run,
        userId: user.id,
        organizationId,
      });

      return reply.send(conversation);
    },
  );
};

export default scheduleTriggerRoutes;

async function ensureRunConversation(params: {
  run: z.infer<typeof SelectScheduleTriggerRunSchema>;
  userId: string;
  organizationId: string;
}): Promise<z.infer<typeof SelectConversationSchema>> {
  const { run, userId, organizationId } = params;

  const trigger = await ScheduleTriggerModel.findById(run.triggerId);
  if (!trigger) {
    throw new ApiError(400, "The trigger for this run no longer exists");
  }

  // A project-scoped run's conversation was created up front by the handler;
  // otherwise create it now, owned by the requester so follow-up chat uses
  // their own model/API key access.
  let conversation = run.chatConversationId
    ? await ConversationModel.findByIdInOrganization({
        id: run.chatConversationId,
        organizationId,
      })
    : null;
  if (!conversation) {
    try {
      conversation = await createAndLinkRunConversation({
        run,
        trigger,
        ownerUserId: userId,
        organizationId,
      });
    } catch {
      throw new ApiError(
        400,
        "The agent used for this run no longer exists or is unavailable",
      );
    }
  }

  // Sync the run artifact into the conversation if missing.
  if (run.artifact && !conversation.artifact) {
    const updated = await ConversationModel.update(
      conversation.id,
      conversation.userId,
      organizationId,
      { artifact: run.artifact },
    );
    if (updated) {
      conversation = updated;
    }
  }

  // Reconstruct the chat from the run's interactions (the up-front path links
  // the conversation before any interactions exist, so this is where messages
  // are populated for project runs too).
  await backfillRunConversationMessages({
    conversation,
    trigger,
    run,
    ownerUserId: conversation.userId,
  });

  // A failed run that never executed (a skip, or a pre-execution failure) has no
  // transcript to backfill — surface its error as a chat error so the chat shows
  // the prompt + an error card instead of a blank thread.
  await ensureFailedRunErrorVisible({ conversation, run, trigger });

  const refreshedConversation = await ConversationModel.findById({
    id: conversation.id,
    userId: conversation.userId,
    organizationId,
  });
  if (!refreshedConversation) {
    throw new ApiError(500, "Failed to load the run conversation");
  }

  return refreshedConversation;
}
