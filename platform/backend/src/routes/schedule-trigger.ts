import type { IncomingHttpHeaders } from "node:http";
import {
  calculatePaginationMeta,
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasAnyAgentTypeAdminPermission, hasPermission } from "@/auth";
import config from "@/config";
import logger from "@/logging";
import {
  AgentModel,
  AgentTeamModel,
  ConversationModel,
  ScheduleTriggerModel,
  ScheduleTriggerRunModel,
} from "@/models";
import { projectService } from "@/services/project";
import { ensureTriggerConversation } from "@/services/scheduled-run-conversation";
import { taskQueueService } from "@/task-queue";
import {
  ApiError,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  ScheduleTriggerConfigurationSchema,
  ScheduleTriggerConfigurationSchemaBase,
  ScheduleTriggerRunStatusSchema,
  SelectConversationSchema,
  SelectScheduleTriggerRunSchema,
  SelectScheduleTriggerSchema,
  UuidIdSchema,
} from "@/types";

const ScheduleTriggerBodyFieldsSchema = z.object({
  name: z.string().min(1),
  // Optional: callers without `agent:read` (e.g. a basic-user role) omit it and
  // the handler falls back to the org's default agent.
  agentId: UuidIdSchema.optional(),
  // Required at the handler when the projects feature is on; ignored otherwise.
  projectId: UuidIdSchema.optional(),
  enabled: z.boolean().optional().default(true),
  ...ScheduleTriggerConfigurationSchemaBase.shape,
});

const CreateScheduleTriggerBodySchema =
  ScheduleTriggerBodyFieldsSchema.superRefine((data, ctx) => {
    const result = ScheduleTriggerConfigurationSchema.safeParse(data);
    if (result.success) {
      return;
    }

    for (const issue of result.error.issues) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: issue.message,
        path: issue.path,
      });
    }
  });

const UpdateScheduleTriggerBodySchema =
  ScheduleTriggerBodyFieldsSchema.partial().superRefine((data, ctx) => {
    if (Object.keys(data).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one field must be provided",
      });
      return;
    }

    const result =
      ScheduleTriggerConfigurationSchemaBase.partial().safeParse(data);
    if (result.success) {
      return;
    }

    for (const issue of result.error.issues) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: issue.message,
        path: issue.path,
      });
    }
  });

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
        headers,
      },
      reply,
    ) => {
      // By default, filter to the current user's tasks
      let actorUserId: string | undefined = user.id;
      let actorUserIds: string[] | undefined;
      let excludeActorUserId: string | undefined;

      if (showAll) {
        const { success: isScheduledTaskAdmin } = await hasPermission(
          { scheduledTask: ["admin"] },
          headers,
        );
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
      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });

      // A caller who can pick an agent (`agent:read`) passes one and we verify
      // access; a caller who can't (e.g. a basic-user role) omits it and we fall
      // back to the org's default agent.
      let agentId: string;
      if (body.agentId) {
        const agent = await AgentModel.findById(
          body.agentId,
          user.id,
          isAgentAdmin,
        );
        if (!agent) {
          throw new ApiError(
            403,
            "You do not have access to the selected agent",
          );
        }
        if (
          agent.organizationId !== organizationId ||
          agent.agentType !== "agent"
        ) {
          throw new ApiError(
            400,
            "Scheduled triggers require an internal agent",
          );
        }
        agentId = agent.id;
      } else {
        const defaultAgent = await AgentModel.findDefaultByType({
          organizationId,
          agentType: "agent",
        });
        if (!defaultAgent) {
          throw new ApiError(
            400,
            "No default agent is configured for scheduled tasks",
          );
        }
        agentId = defaultAgent.id;
      }

      // With the projects feature on, schedules belong to a project; verify the
      // caller can access it. With the feature off, scheduling stays unscoped.
      let projectId: string | null = null;
      if (config.projects.enabled) {
        if (!body.projectId) {
          throw new ApiError(400, "A project is required for scheduled tasks");
        }
        await projectService.get({
          id: body.projectId,
          organizationId,
          userId: user.id,
        });
        projectId = body.projectId;
      }

      const trigger = await ScheduleTriggerModel.create({
        organizationId,
        name: body.name,
        agentId,
        projectId,
        messageTemplate: body.messageTemplate,
        cronExpression: body.cronExpression,
        timezone: body.timezone,
        enabled: body.enabled ?? true,
        actorUserId: user.id,
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
    async ({ params: { id }, user, organizationId, headers }, reply) => {
      const trigger = await findAccessibleTriggerOrThrow({
        id,
        userId: user.id,
        organizationId,
        headers,
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
    async ({ params: { id }, body, user, organizationId, headers }, reply) => {
      const existing = await findAccessibleTriggerOrThrow({
        id,
        userId: user.id,
        organizationId,
        headers,
      });
      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });

      // Only validate the agent when the caller is actually changing it. A
      // caller without `agent:read` editing other fields omits agentId and must
      // not be access-checked against the trigger's existing (default) agent.
      if (body.agentId !== undefined && body.agentId !== existing.agentId) {
        const agent = await AgentModel.findById(
          body.agentId,
          user.id,
          isAgentAdmin,
        );
        if (!agent) {
          throw new ApiError(
            403,
            "You do not have access to the selected agent",
          );
        }
        if (
          agent.organizationId !== organizationId ||
          agent.agentType !== "agent"
        ) {
          throw new ApiError(
            400,
            "Scheduled triggers require an internal agent",
          );
        }

        const actorIsAgentAdmin = await hasAnyAgentTypeAdminPermission({
          userId: existing.actorUserId,
          organizationId,
        });
        const actorHasAgentAccess = await AgentTeamModel.userHasAgentAccess(
          existing.actorUserId,
          body.agentId,
          actorIsAgentAdmin,
        );
        if (!actorHasAgentAccess) {
          throw new ApiError(
            400,
            "The stored trigger actor must have access to the selected agent",
          );
        }
      }

      const cronExpression = body.cronExpression ?? existing.cronExpression;
      const timezone = body.timezone ?? existing.timezone;
      const messageTemplate = body.messageTemplate ?? existing.messageTemplate;
      const validation = ScheduleTriggerConfigurationSchema.safeParse({
        cronExpression,
        timezone,
        messageTemplate,
      });
      if (!validation.success) {
        const firstIssue = validation.error.issues[0];
        throw new ApiError(
          400,
          firstIssue?.message ?? "Invalid schedule trigger configuration",
        );
      }

      // Guard project re-scoping the same way create does: only with the
      // feature on and only to a project the caller can access.
      if (body.projectId !== undefined) {
        if (!config.projects.enabled) {
          throw new ApiError(
            400,
            "Projects are not enabled on this deployment",
          );
        }
        await projectService.get({
          id: body.projectId,
          organizationId,
          userId: user.id,
        });
      }

      const updated = await ScheduleTriggerModel.update(id, body);

      if (!updated) {
        throw new ApiError(404, "Schedule trigger not found");
      }

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
    async ({ params: { id }, user, organizationId, headers }, reply) => {
      await findAccessibleTriggerOrThrow({
        id,
        userId: user.id,
        organizationId,
        headers,
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
    async ({ params: { id }, user, organizationId, headers }, reply) => {
      await findAccessibleTriggerOrThrow({
        id,
        userId: user.id,
        organizationId,
        headers,
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
    async ({ params: { id }, user, organizationId, headers }, reply) => {
      await findAccessibleTriggerOrThrow({
        id,
        userId: user.id,
        organizationId,
        headers,
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
    async ({ params: { id }, user, organizationId, headers }, reply) => {
      const trigger = await findAccessibleTriggerOrThrow({
        id,
        userId: user.id,
        organizationId,
        headers,
      });

      const run = await ScheduleTriggerRunModel.createManualRun({
        trigger,
        initiatedByUserId: user.id,
      });

      await taskQueueService.enqueue({
        taskType: "schedule_trigger_run_execute",
        payload: { runId: run.id, triggerId: trigger.id },
      });

      logger.info(
        { runId: run.id, triggerId: trigger.id, userId: user.id },
        "Manual schedule trigger run created",
      );

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
        headers,
      },
      reply,
    ) => {
      const trigger = await findAccessibleTriggerOrThrow({
        id,
        userId: user.id,
        organizationId,
        headers,
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
    async ({ params: { id, runId }, user, organizationId, headers }, reply) => {
      const run = await findAccessibleRunOrThrow({
        triggerId: id,
        runId,
        userId: user.id,
        organizationId,
        headers,
      });

      return reply.send(run);
    },
  );

  fastify.post(
    "/api/schedule-triggers/:id/conversation",
    {
      schema: {
        operationId: RouteId.CreateScheduleTriggerConversation,
        description:
          "Create or return the single chat conversation shared by all of a schedule's runs",
        tags: ["Schedule Triggers"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(SelectConversationSchema),
      },
    },
    async ({ params: { id }, user, organizationId, headers }, reply) => {
      const trigger = await findAccessibleTriggerOrThrow({
        id,
        userId: user.id,
        organizationId,
        headers,
        allowProjectAccess: true,
      });

      const conversation = await openTriggerConversation({
        trigger,
        organizationId,
      });

      return reply.send(conversation);
    },
  );

  fastify.post(
    "/api/schedule-triggers/:id/runs/:runId/conversation",
    {
      schema: {
        operationId: RouteId.CreateScheduleTriggerRunConversation,
        description:
          "Return the chat conversation that wraps a schedule's runs (resolved from the run's trigger)",
        tags: ["Schedule Triggers"],
        params: z.object({
          id: UuidIdSchema,
          runId: UuidIdSchema,
        }),
        response: constructResponseSchema(SelectConversationSchema),
      },
    },
    async ({ params: { id, runId }, user, organizationId, headers }, reply) => {
      const run = await findAccessibleRunOrThrow({
        triggerId: id,
        runId,
        userId: user.id,
        organizationId,
        headers,
        allowProjectAccess: true,
      });

      const trigger = await ScheduleTriggerModel.findById(run.triggerId);
      if (!trigger) {
        throw new ApiError(400, "The trigger for this run no longer exists");
      }

      const conversation = await openTriggerConversation({
        trigger,
        organizationId,
      });

      return reply.send(conversation);
    },
  );
};

export default scheduleTriggerRoutes;

async function findAccessibleTriggerOrThrow(params: {
  id: string;
  userId: string;
  organizationId: string;
  headers: IncomingHttpHeaders;
  /**
   * When set, a project schedule is also accessible to anyone with access to its
   * project (mirrors the project-scoped listing, which shows every member's
   * schedules). Used by the read-only open-chat routes — NOT by the management
   * routes (edit/delete/run), which stay owner-or-admin.
   */
  allowProjectAccess?: boolean;
}): Promise<z.infer<typeof SelectScheduleTriggerSchema>> {
  const trigger = await ScheduleTriggerModel.findById(params.id);
  if (!trigger || trigger.organizationId !== params.organizationId) {
    throw new ApiError(404, "Schedule trigger not found");
  }

  // Owner always has access
  if (trigger.actorUserId === params.userId) {
    return trigger;
  }

  // scheduledTask:admin can access any trigger
  const { success: isScheduledTaskAdmin } = await hasPermission(
    { scheduledTask: ["admin"] },
    params.headers,
  );
  if (isScheduledTaskAdmin) {
    return trigger;
  }

  // For read-only open-chat routes, project access grants access to the
  // project's schedules (projectService.get throws if the user can't see it).
  if (params.allowProjectAccess && trigger.projectId) {
    try {
      await projectService.get({
        id: trigger.projectId,
        organizationId: params.organizationId,
        userId: params.userId,
      });
      return trigger;
    } catch {
      // No project access — fall through to the 403 below.
    }
  }

  throw new ApiError(403, "You do not have access to this scheduled task");
}

async function findAccessibleRunOrThrow(params: {
  triggerId: string;
  runId: string;
  userId: string;
  organizationId: string;
  headers: IncomingHttpHeaders;
  allowProjectAccess?: boolean;
}): Promise<z.infer<typeof SelectScheduleTriggerRunSchema>> {
  await findAccessibleTriggerOrThrow({
    id: params.triggerId,
    userId: params.userId,
    organizationId: params.organizationId,
    headers: params.headers,
    allowProjectAccess: params.allowProjectAccess,
  });

  const run = await ScheduleTriggerRunModel.findById(params.runId);
  if (
    !run ||
    run.organizationId !== params.organizationId ||
    run.triggerId !== params.triggerId
  ) {
    throw new ApiError(404, "Schedule trigger run not found");
  }

  return run;
}

/**
 * Open the schedule's single shared chat conversation, creating it on first use.
 * All of a schedule's runs are wrapped into this one conversation; its messages
 * are populated by the run handler as each run finishes, so this just resolves
 * (and lazily creates) the conversation — it never backfills per run. Owned by
 * the trigger's actor so every run's chat has one stable owner.
 */
async function openTriggerConversation(params: {
  trigger: z.infer<typeof SelectScheduleTriggerSchema>;
  organizationId: string;
}): Promise<z.infer<typeof SelectConversationSchema>> {
  const { trigger, organizationId } = params;

  let conversation: z.infer<typeof SelectConversationSchema>;
  try {
    conversation = await ensureTriggerConversation({
      trigger,
      ownerUserId: trigger.actorUserId,
      organizationId,
    });
  } catch {
    throw new ApiError(
      400,
      "The agent used for this schedule no longer exists or is unavailable",
    );
  }

  const refreshedConversation = await ConversationModel.findByIdInOrganization({
    id: conversation.id,
    organizationId,
  });
  if (!refreshedConversation) {
    throw new ApiError(500, "Failed to load the schedule conversation");
  }

  return refreshedConversation;
}
