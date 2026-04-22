import type { IncomingHttpHeaders } from "node:http";
import {
  calculatePaginationMeta,
  createPaginatedResponseSchema,
  DynamicInteraction,
  PaginationQuerySchema,
  type PartialUIMessage,
  RouteId,
} from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasAnyAgentTypeAdminPermission, hasPermission } from "@/auth";
import logger from "@/logging";
import {
  AgentModel,
  AgentTeamModel,
  ConversationModel,
  InteractionModel,
  MessageModel,
  ScheduleTriggerModel,
  ScheduleTriggerRunModel,
} from "@/models";
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
import { resolveConversationLlmSelectionForAgent } from "@/utils/llm-resolution";

const ScheduleTriggerBodyFieldsSchema = z.object({
  name: z.string().min(1),
  agentId: UuidIdSchema,
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
        }),
        ScheduleTriggerModel.countByOrganization({
          organizationId,
          enabled,
          agentIds,
          actorUserId,
          actorUserIds,
          excludeActorUserId,
          name,
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

      const agent = await AgentModel.findById(
        body.agentId,
        user.id,
        isAgentAdmin,
      );
      if (!agent) {
        throw new ApiError(403, "You do not have access to the selected agent");
      }

      if (
        agent.organizationId !== organizationId ||
        agent.agentType !== "agent"
      ) {
        throw new ApiError(400, "Scheduled triggers require an internal agent");
      }

      const trigger = await ScheduleTriggerModel.create({
        organizationId,
        name: body.name,
        agentId: body.agentId,
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

      const agentId = body.agentId ?? existing.agentId;
      const agent = await AgentModel.findById(agentId, user.id, isAgentAdmin);
      if (!agent) {
        throw new ApiError(403, "You do not have access to the selected agent");
      }

      if (
        agent.organizationId !== organizationId ||
        agent.agentType !== "agent"
      ) {
        throw new ApiError(400, "Scheduled triggers require an internal agent");
      }

      const isChangingAgent =
        body.agentId !== undefined && body.agentId !== existing.agentId;
      if (isChangingAgent) {
        const actorIsAgentAdmin = await hasAnyAgentTypeAdminPermission({
          userId: existing.actorUserId,
          organizationId,
        });
        const actorHasAgentAccess = await AgentTeamModel.userHasAgentAccess(
          existing.actorUserId,
          agentId,
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

  // scheduledTask:admin can access any trigger
  const { success: isScheduledTaskAdmin } = await hasPermission(
    { scheduledTask: ["admin"] },
    params.headers,
  );
  if (isScheduledTaskAdmin) {
    return trigger;
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

  const agentId = trigger.agentId;
  const agent = await AgentModel.findById(agentId);
  if (!agent || agent.organizationId !== organizationId) {
    throw new ApiError(
      400,
      "The agent used for this run no longer exists or is unavailable",
    );
  }

  const llmSelection = await resolveConversationLlmSelectionForAgent({
    agent: {
      llmApiKeyId: agent.llmApiKeyId ?? null,
      llmModel: agent.llmModel ?? null,
    },
    organizationId,
    userId,
  });

  if (run.chatConversationId) {
    const existing = await ConversationModel.findById({
      id: run.chatConversationId,
      userId,
      organizationId,
    });
    if (existing) {
      // Sync run artifact into conversation if missing
      if (run.artifact && !existing.artifact) {
        const updated = await ConversationModel.update(
          existing.id,
          userId,
          organizationId,
          { artifact: run.artifact },
        );
        if (updated) {
          return updated;
        }
      }
      return existing;
    }
  }

  const interactionResult = await InteractionModel.findAllPaginated(
    { limit: 50, offset: 0 },
    { sortBy: "createdAt", sortDirection: "desc" },
    userId,
    true,
    {
      profileId: agentId,
      sessionId: `scheduled-${run.id}`,
    },
  );
  const uiMessages = buildMessagesFromInteractions(
    interactionResult.data,
    trigger.messageTemplate,
  );
  const conversationTitle = buildRunConversationSeedTitle(
    trigger.messageTemplate,
  );

  const conversation = await ConversationModel.create({
    userId,
    organizationId,
    agentId,
    title: conversationTitle,
    selectedModel: llmSelection.selectedModel,
    selectedProvider: llmSelection.selectedProvider,
    chatApiKeyId: llmSelection.chatApiKeyId,
    artifact: run.artifact ?? undefined,
  });

  const createdAt = Date.now();
  await MessageModel.bulkCreate(
    uiMessages.map((message, index) => ({
      conversationId: conversation.id,
      role: message.role,
      content: message,
      createdAt: new Date(createdAt + index),
    })),
  );

  await ScheduleTriggerRunModel.setChatConversationId(run.id, conversation.id);

  const refreshedConversation = await ConversationModel.findById({
    id: conversation.id,
    userId,
    organizationId,
  });
  if (!refreshedConversation) {
    throw new ApiError(500, "Failed to load the run conversation");
  }

  return refreshedConversation;
}

function buildMessagesFromInteractions(
  interactions: Array<{
    type: string;
    request: unknown;
    response: unknown;
    model?: string | null;
    dualLlmAnalyses?: unknown;
  }>,
  messageTemplate: string,
): PartialUIMessage[] {
  // Interactions are fetched desc — the first one is the most recent (last in
  // the agentic loop). Its request contains the full conversation history and
  // its response contains the final LLM reply. Using only the last interaction
  // avoids duplicate messages that would result from earlier interactions
  // replaying the same conversation prefix.
  const lastInteraction = interactions[0];
  const messages: PartialUIMessage[] = [];

  if (lastInteraction) {
    try {
      const di = new DynamicInteraction(lastInteraction as never);
      messages.push(...di.mapToUiMessages());
    } catch {
      // Skip if interaction can't be parsed
    }
  }

  if (messages.length > 0) {
    return messages;
  }

  // Fallback: simple prompt + placeholder
  return [
    {
      role: "user",
      parts: [{ type: "text", text: messageTemplate }],
    },
    {
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "No output was captured for this scheduled run.",
        },
      ],
    },
  ];
}

function buildRunConversationSeedTitle(prompt: string): string {
  const normalizedPrompt = prompt.trim().replace(/\s+/g, " ");

  if (!normalizedPrompt) {
    return "Scheduled run";
  }

  return normalizedPrompt.length > 72
    ? `${normalizedPrompt.slice(0, 69).trimEnd()}...`
    : normalizedPrompt;
}
