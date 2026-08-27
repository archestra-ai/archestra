import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  getAgentTypePermissionChecker,
  requireAgentModifyPermission,
} from "@/auth";
import { runnerRuntimeManager } from "@/k8s/runner-runtime";
import { AgentModel, AgentRunModel, TeamModel } from "@/models";
import {
  deleteAgentDeploymentCredential,
  preflightAgentDeploymentCredentials,
  setAgentDeploymentCredential,
} from "@/services/runners/credentials";
import { resolveAgentDeployment } from "@/services/runners/pod-execution";
import {
  type Agent,
  type AgentDeployment,
  ApiError,
  constructResponseSchema,
  MissingAgentDeploymentCredentialSchema,
  SelectAgentExecutionSchema,
} from "@/types";

const agentBackgroundExecutionRoutes: FastifyPluginAsyncZod = async (
  fastify,
) => {
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
        await requireWritableAgent({ request, agent });
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
        await requireWritableAgent({ request, agent });
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
};

export default agentBackgroundExecutionRoutes;

// ===================== internals =====================

type AgentRequest = {
  params: { id: string };
  user: { id: string };
  organizationId: string;
};

async function requireReadableDeployment(
  request: AgentRequest,
): Promise<AgentDeployment> {
  return (await requireReadableDeploymentWithAgent(request)).deployment;
}

async function requireReadableDeploymentWithAgent(
  request: AgentRequest,
): Promise<{ agent: Agent; deployment: AgentDeployment }> {
  if (!runnerRuntimeManager.isEnabled) {
    throw new ApiError(404, "Not found");
  }
  const agent = await requireReadableAgent(request);
  const deployment = resolveAgentDeployment(agent);
  if (!deployment) {
    throw new ApiError(404, "Background execution is not configured");
  }
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
