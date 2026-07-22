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
import logger from "@/logging";
import {
  AgentModel,
  AgentTeamModel,
  ConversationModel,
  ProjectModel,
  ProjectShareModel,
  ScheduleTriggerModel,
  ScheduleTriggerRunModel,
} from "@/models";
import { projectService } from "@/services/project";
import {
  backfillRunConversationMessages,
  createAndLinkRunConversation,
  ensureFailedRunErrorVisible,
} from "@/services/scheduled-run-conversation";
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
  // Optional in the shared shape so updates can omit it; create requires it
  // (see CreateScheduleTriggerBodySchema) since a scheduled task is scoped to a
  // project.
  projectId: UuidIdSchema.optional(),
  enabled: z.boolean().optional().default(true),
  ...ScheduleTriggerConfigurationSchemaBase.shape,
});

// A scheduled task is scoped to a project, so create requires projectId — the
// contract clients see, not just a runtime check.
const CreateScheduleTriggerBodySchema = ScheduleTriggerBodyFieldsSchema.extend({
  projectId: UuidIdSchema,
}).superRefine((data, ctx) => {
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

      // projectId is required by the schema; verify the caller can access it.
      const projectId = body.projectId;
      await projectService.get({
        id: projectId,
        organizationId,
        userId: user.id,
      });

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

      // Guard project re-scoping: only to a project the caller can access.
      if (body.projectId !== undefined) {
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
    async ({ params: { id, runId }, user, organizationId, headers }, reply) => {
      // Access is owner / scheduledTask:admin (findAccessibleRunOrThrow) — the
      // same gate as every other schedule op. Loading the run conversation can
      // MINT one when it isn't linked yet (createAndLinkRunConversation below),
      // so it stays on that existing permission rather than any project scope.
      const run = await findAccessibleRunOrThrow({
        triggerId: id,
        runId,
        userId: user.id,
        organizationId,
        headers,
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

async function findAccessibleTriggerOrThrow(params: {
  id: string;
  userId: string;
  organizationId: string;
  headers: IncomingHttpHeaders;
}): Promise<z.infer<typeof SelectScheduleTriggerSchema>> {
  const trigger = await ScheduleTriggerModel.findById(params.id);
  if (!trigger || trigger.organizationId !== params.organizationId) {
    throw new ApiError(404, "Schedule trigger not found");
  }

  // Owner always has access
  if (trigger.actorUserId === params.userId) {
    return trigger;
  }

  // scheduledTask:admin can access any trigger (incl. ones inside a project).
  // Project oversight of schedules rides this existing permission — there is no
  // separate project:admin path here.
  const { success: isScheduledTaskAdmin } = await hasPermission(
    { scheduledTask: ["admin"] },
    params.headers,
  );
  if (isScheduledTaskAdmin) {
    return trigger;
  }

  // Project members may read the runs of a schedule that belongs to a project
  // they can access. Reuses the same ProjectShareModel.userCanAccessProject
  // check that backs GET /api/projects/:id (via projectService.requireViewable).
  if (trigger.projectId) {
    const project = await ProjectModel.findById(trigger.projectId);
    if (
      project &&
      (await ProjectShareModel.userCanAccessProject({
        project,
        userId: params.userId,
        organizationId: params.organizationId,
      }))
    ) {
      return trigger;
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
}): Promise<z.infer<typeof SelectScheduleTriggerRunSchema>> {
  await findAccessibleTriggerOrThrow({
    id: params.triggerId,
    userId: params.userId,
    organizationId: params.organizationId,
    headers: params.headers,
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
