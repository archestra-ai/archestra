import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  getAgentTypePermissionChecker,
  requireAgentModifyPermission,
  userHasPermission,
} from "@/auth";
import config from "@/config";
import { A2ATaskModel, AgentModel, AgentRunModel, TeamModel } from "@/models";
import {
  isAnyRunnerBackendEnabled,
  resolveRunnerBackend,
} from "@/services/runners/backends";
import {
  deleteAgentDeploymentCredential,
  preflightAgentDeploymentCredentials,
  setAgentDeploymentCredential,
} from "@/services/runners/credentials";
import { resolveAgentDeployment } from "@/services/runners/pod-execution";
import {
  cancelDetachedAgentTask,
  startDetachedAgentTask,
} from "@/services/runners/start-task";
import {
  type Agent,
  type AgentDeployment,
  ApiError,
  constructResponseSchema,
  MissingAgentDeploymentCredentialSchema,
  SelectAgentExecutionSchema,
  SelectAgentExecutionSessionSchema,
  StartAgentExecutionResponseSchema,
} from "@/types";

const agentBackgroundExecutionRoutes: FastifyPluginAsyncZod = async (
  fastify,
) => {
  fastify.addHook("preHandler", async () => {
    if (!isAnyRunnerBackendEnabled()) throw new ApiError(404, "Not found");
  });

  fastify.get(
    "/api/agents/:id/background-execution/preflight",
    {
      schema: {
        operationId: RouteId.GetAgentBackgroundExecutionPreflight,
        description:
          "Report credentials the current user still needs before this Agent can execute delegated work in its deployment",
        tags: ["Agents"],
        params: z.object({ id: z.string().uuid() }),
        response: constructResponseSchema(
          z.object({
            ready: z.boolean(),
            configured: z.array(z.string()),
            missing: z.array(MissingAgentDeploymentCredentialSchema),
            misconfigured: z.array(MissingAgentDeploymentCredentialSchema),
          }),
        ),
      },
    },
    async (request, reply) => {
      const deployment = await requireReadableDeployment(request);
      const preflight = await preflightAgentDeploymentCredentials({
        deployment,
        organizationId: request.organizationId,
        userId: request.user.id,
      });
      return reply.send({
        ready:
          preflight.missing.length === 0 &&
          preflight.misconfigured.length === 0,
        ...preflight,
      });
    },
  );

  fastify.put(
    "/api/agents/:id/background-execution/credentials/:key",
    {
      schema: {
        operationId: RouteId.SetAgentBackgroundExecutionCredential,
        description:
          "Store or replace one credential declared by an Agent's Background execution configuration",
        tags: ["Agents"],
        params: z.object({
          id: z.string().uuid(),
          key: z.string().min(1).max(128),
        }),
        body: z.object({ value: z.string().min(1).max(20_000) }),
        response: constructResponseSchema(
          z.object({ configured: z.literal(true) }),
        ),
      },
    },
    async (request, reply) => {
      const { agent, deployment } =
        await requireReadableDeploymentWithAgent(request);
      const declaration = requireCredentialDeclaration(
        deployment,
        request.params.key,
      );
      if (declaration.scope === "shared") {
        if (declaration.credentialId) {
          await requireExecutionCredentialAdmin(request);
          const before = await preflightAgentDeploymentCredentials({
            deployment,
            organizationId: request.organizationId,
            userId: request.user.id,
          });
          request.auditBefore = {
            executionConnection: {
              credentialId: declaration.credentialId,
              configured: before.configured.includes(declaration.key),
            },
          };
          request.auditAfter = {
            executionConnection: {
              credentialId: declaration.credentialId,
              configured: true,
            },
          };
        } else {
          await requireWritableAgent({ request, agent });
        }
      } else {
        request.auditSkip = true;
      }
      await setAgentDeploymentCredential({
        deployment,
        organizationId: request.organizationId,
        userId: request.user.id,
        key: declaration.key,
        value: request.body.value,
      });
      return reply.send({ configured: true as const });
    },
  );

  fastify.delete(
    "/api/agents/:id/background-execution/credentials/:key",
    {
      schema: {
        operationId: RouteId.DeleteAgentBackgroundExecutionCredential,
        description:
          "Remove one stored Background execution credential value without changing its declaration",
        tags: ["Agents"],
        params: z.object({
          id: z.string().uuid(),
          key: z.string().min(1).max(128),
        }),
        response: constructResponseSchema(z.object({ deleted: z.boolean() })),
      },
    },
    async (request, reply) => {
      const { agent, deployment } =
        await requireReadableDeploymentWithAgent(request);
      const declaration = requireCredentialDeclaration(
        deployment,
        request.params.key,
      );
      if (declaration.scope === "shared") {
        if (declaration.credentialId) {
          await requireExecutionCredentialAdmin(request);
          request.auditBefore = {
            executionConnection: {
              credentialId: declaration.credentialId,
              configured: true,
            },
          };
          request.auditAfter = {
            executionConnection: {
              credentialId: declaration.credentialId,
              configured: false,
            },
          };
        } else {
          await requireWritableAgent({ request, agent });
        }
      } else {
        request.auditSkip = true;
      }
      const result = await deleteAgentDeploymentCredential({
        deployment,
        organizationId: request.organizationId,
        userId: request.user.id,
        key: declaration.key,
      });
      if (!result.deleted) {
        throw new ApiError(404, "Credential is not configured");
      }
      return reply.send({ deleted: true });
    },
  );

  fastify.get(
    "/api/agents/:id/executions",
    {
      schema: {
        operationId: RouteId.GetAgentExecutions,
        description:
          "List background executions created by delegated tasks for this Agent",
        tags: ["Agents"],
        params: z.object({ id: z.string().uuid() }),
        response: constructResponseSchema(z.array(SelectAgentExecutionSchema)),
      },
    },
    async (request, reply) => {
      await requireReadableAgent(request);
      return reply.send(
        await AgentRunModel.listForAgent({
          agentId: request.params.id,
          organizationId: request.organizationId,
        }),
      );
    },
  );

  fastify.post(
    "/api/agents/:id/executions",
    {
      schema: {
        operationId: RouteId.StartAgentExecution,
        description:
          "Start a durable Background execution session with this Agent",
        tags: ["Agents"],
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          message: z.string().trim().min(1).max(100_000),
          attachments: z
            .array(
              z
                .object({
                  name: z.string().trim().min(1).max(255),
                  contentType: z.string().trim().min(1).max(255),
                  contentBase64: z
                    .string()
                    .min(1)
                    .refine(
                      isCanonicalBase64,
                      "Attachment content is not valid base64",
                    ),
                })
                .superRefine((attachment, context) => {
                  const bytes = Buffer.from(attachment.contentBase64, "base64");
                  if (bytes.byteLength === 0) {
                    context.addIssue({
                      code: "custom",
                      message: "Attachment content is not valid base64",
                    });
                  }
                  if (
                    bytes.byteLength > config.chat.attachmentStorageBytesLimit
                  ) {
                    context.addIssue({
                      code: "custom",
                      message: `Attachments may not exceed ${config.chat.attachmentStorageBytesLimit} bytes`,
                    });
                  }
                }),
            )
            .max(20)
            .optional(),
        }),
        response: constructResponseSchema(StartAgentExecutionResponseSchema),
      },
    },
    async (request, reply) => {
      const { agent, deployment } =
        await requireReadableDeploymentWithAgent(request);
      const preflight = await preflightAgentDeploymentCredentials({
        deployment,
        organizationId: request.organizationId,
        userId: request.user.id,
      });
      if (preflight.missing.length > 0) {
        throw new ApiError(
          409,
          `Add your required credentials before starting this execution: ${preflight.missing
            .map((entry) => entry.label)
            .join(", ")}`,
        );
      }
      if (preflight.misconfigured.length > 0) {
        throw new ApiError(
          409,
          `An Agent administrator must configure: ${preflight.misconfigured
            .map((entry) => entry.label)
            .join(", ")}`,
        );
      }

      const task = await startDetachedAgentTask({
        actor: {
          id: request.user.id,
          kind: "user",
          organizationId: request.organizationId,
        },
        agentId: agent.id,
        message: request.body.message,
        attachments: request.body.attachments,
        systemParams: {
          sessionId: crypto.randomUUID(),
          source: "chat",
          backgroundExecutionMode: "interactive",
        },
      });
      request.auditResourceId = { value: task.id };
      request.auditAfter = {
        taskId: task.id,
        agentId: agent.id,
        state: task.state,
        attachmentCount: request.body.attachments?.length ?? 0,
      };
      return reply.send({
        taskId: task.id,
        state: task.state,
        agentId: agent.id,
        agentName: agent.name,
        prompt: request.body.message,
        createdAt: task.createdAt,
      });
    },
  );

  fastify.get(
    "/api/agent-executions",
    {
      schema: {
        operationId: RouteId.GetMyAgentExecutions,
        description: "List Background executions started by this user",
        tags: ["Agents"],
        response: constructResponseSchema(
          z.array(SelectAgentExecutionSessionSchema),
        ),
      },
    },
    async (request, reply) => {
      return reply.send(
        await AgentRunModel.listForActor({
          actorUserId: request.user.id,
          organizationId: request.organizationId,
        }),
      );
    },
  );

  fastify.get(
    "/api/agent-executions/:taskId",
    {
      schema: {
        operationId: RouteId.GetMyAgentExecution,
        description: "Get one Background execution started by this user",
        tags: ["Agents"],
        params: z.object({ taskId: z.string().uuid() }),
        response: constructResponseSchema(SelectAgentExecutionSessionSchema),
      },
    },
    async (request, reply) => {
      const execution = await AgentRunModel.findForActorByTaskId({
        taskId: request.params.taskId,
        actorUserId: request.user.id,
        organizationId: request.organizationId,
      });
      if (!execution) throw new ApiError(404, "Execution not found");
      return reply.send(execution);
    },
  );

  fastify.patch(
    "/api/agent-executions/:taskId",
    {
      schema: {
        operationId: RouteId.UpdateAgentExecution,
        description: "Rename one Background execution started by this user",
        tags: ["Agents"],
        params: z.object({ taskId: z.string().uuid() }),
        body: z.object({ title: z.string().trim().min(1).max(100) }),
        response: constructResponseSchema(SelectAgentExecutionSessionSchema),
      },
    },
    async (request, reply) => {
      const execution = await requireOwnedExecution(request);
      request.auditResourceId = { value: execution.taskId };
      request.auditBefore = {
        taskId: execution.taskId,
        agentId: execution.agentId,
        title: execution.title,
      };
      const updated = await AgentRunModel.updateTitleForActor({
        taskId: execution.taskId,
        actorUserId: request.user.id,
        organizationId: request.organizationId,
        title: request.body.title,
      });
      if (!updated) throw new ApiError(404, "Execution not found");
      request.auditAfter = {
        taskId: updated.taskId,
        agentId: updated.agentId,
        title: updated.title,
      };
      return reply.send(updated);
    },
  );

  fastify.post(
    "/api/agent-executions/:taskId/cancel",
    {
      schema: {
        operationId: RouteId.CancelAgentExecution,
        description:
          "Cancel one active Background execution session started by this user",
        tags: ["Agents"],
        params: z.object({ taskId: z.string().uuid() }),
        response: constructResponseSchema(
          z.object({
            taskId: z.string().uuid(),
            state: z.literal("TASK_STATE_CANCELED"),
          }),
        ),
      },
    },
    async (request, reply) => {
      const execution = await requireOwnedExecution(request);
      request.auditResourceId = { value: execution.taskId };
      request.auditBefore = {
        taskId: execution.taskId,
        agentId: execution.agentId,
        state: execution.state,
      };

      const canceled = await cancelDetachedAgentTask({
        actor: {
          id: request.user.id,
          kind: "user",
          organizationId: request.organizationId,
        },
        agentId: execution.agentId,
        taskId: execution.taskId,
      });
      request.auditAfter = {
        taskId: execution.taskId,
        agentId: execution.agentId,
        state: canceled.status.state,
      };
      return reply.send({
        taskId: execution.taskId,
        state: "TASK_STATE_CANCELED" as const,
      });
    },
  );

  fastify.delete(
    "/api/agent-executions/:taskId",
    {
      schema: {
        operationId: RouteId.DeleteAgentExecution,
        description:
          "Delete one finished Background execution session started by this user",
        tags: ["Agents"],
        params: z.object({ taskId: z.string().uuid() }),
        response: constructResponseSchema(
          z.object({ deleted: z.literal(true) }),
        ),
      },
    },
    async (request, reply) => {
      const execution = await requireOwnedExecution(request);
      if (!execution.endedAt) {
        throw new ApiError(409, "Stop the execution before deleting it");
      }
      request.auditResourceId = { value: execution.taskId };
      request.auditBefore = {
        taskId: execution.taskId,
        agentId: execution.agentId,
        title: execution.title,
        state: execution.state,
      };
      await A2ATaskModel.delete(execution.taskId);
      request.auditAfter = { deleted: true };
      return reply.send({ deleted: true as const });
    },
  );
};

export default agentBackgroundExecutionRoutes;

// ===================== internals =====================

type AgentRequest = {
  params: { id: string };
  user: { id: string };
  organizationId: string;
};

type OwnedExecutionRequest = {
  params: { taskId: string };
  user: { id: string };
  organizationId: string;
};

async function requireOwnedExecution(request: OwnedExecutionRequest) {
  const execution = await AgentRunModel.findForActorByTaskId({
    taskId: request.params.taskId,
    actorUserId: request.user.id,
    organizationId: request.organizationId,
  });
  if (!execution) throw new ApiError(404, "Execution not found");
  return execution;
}

async function requireReadableDeployment(
  request: AgentRequest,
): Promise<AgentDeployment> {
  return (await requireReadableDeploymentWithAgent(request)).deployment;
}

async function requireReadableDeploymentWithAgent(
  request: AgentRequest,
): Promise<{ agent: Agent; deployment: AgentDeployment }> {
  if (!isAnyRunnerBackendEnabled()) {
    throw new ApiError(404, "Not found");
  }
  const agent = await requireReadableAgent(request);
  const deployment = resolveAgentDeployment(agent);
  if (!deployment) {
    throw new ApiError(404, "Background execution is not configured");
  }
  resolveRunnerBackend(deployment.backend);
  return { agent, deployment };
}

async function requireReadableAgent(request: AgentRequest): Promise<Agent> {
  const candidate = await AgentModel.findById(
    request.params.id,
    request.user.id,
    true,
  );
  if (
    !candidate ||
    candidate.organizationId !== request.organizationId ||
    candidate.agentType !== "agent"
  ) {
    throw new ApiError(404, "Agent not found");
  }
  const checker = await getAgentTypePermissionChecker({
    userId: request.user.id,
    organizationId: request.organizationId,
  });
  try {
    checker.require("agent", "read");
  } catch {
    throw new ApiError(404, "Agent not found");
  }
  if (!checker.isAdmin("agent")) {
    const visible = await AgentModel.findById(
      request.params.id,
      request.user.id,
      false,
    );
    if (!visible) throw new ApiError(404, "Agent not found");
  }
  return candidate;
}

async function requireWritableAgent(params: {
  request: AgentRequest;
  agent: Agent;
}): Promise<void> {
  const checker = await getAgentTypePermissionChecker({
    userId: params.request.user.id,
    organizationId: params.request.organizationId,
  });
  checker.require("agent", "update");
  const userTeamIds = checker.isAdmin("agent")
    ? []
    : await TeamModel.getUserTeamIds(params.request.user.id);
  requireAgentModifyPermission({
    checker,
    agentType: "agent",
    agentScope: params.agent.scope,
    agentAuthorId: params.agent.authorId,
    agentTeamIds: params.agent.teams.map((team) => team.id),
    userTeamIds,
    userId: params.request.user.id,
  });
}

async function requireExecutionCredentialAdmin(
  request: AgentRequest,
): Promise<void> {
  const permitted = await userHasPermission(
    request.user.id,
    request.organizationId,
    "agentSettings",
    "update",
  );
  if (!permitted) {
    throw new ApiError(
      403,
      "Organization Agent settings permission is required to manage this connection",
    );
  }
}

function requireCredentialDeclaration(
  deployment: AgentDeployment,
  key: string,
): NonNullable<AgentDeployment["credentials"]>[number] {
  const declaration = deployment.credentials?.find(
    (entry) => entry.key === key,
  );
  if (!declaration) {
    throw new ApiError(
      404,
      "Credential is not declared by this Agent's Background execution configuration",
    );
  }
  return declaration;
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}
