import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  getAgentTypePermissionChecker,
  isAgentTypeAdmin,
  requireAgentModifyPermission,
  requireAgentTypePermission,
  userHasPermission,
} from "@/auth";
import { clearChatMcpClient } from "@/clients/chat-mcp-client";
import {
  A2aOutboundRunModel,
  A2aRemoteAgentModel,
  AgentModel,
  TeamModel,
} from "@/models";
import {
  listA2aDelegations,
  syncA2aDelegations,
} from "@/services/a2a-outbound-assignments";
import {
  createA2aRemoteAgent,
  deleteA2aRemoteAgent,
  getA2aRemoteAgent,
  inspectA2aRemoteAgent,
  listA2aRemoteAgents,
  updateA2aRemoteAgent,
} from "@/services/a2a-outbound-registry";
import {
  A2aDelegationTargetSchema,
  A2aOutboundRunSummarySchema,
  A2aRemoteAgentInspectionSchema,
  ApiError,
  CreateA2aRemoteAgentRequestSchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  InspectA2aRemoteAgentRequestSchema,
  ListA2aRemoteAgentsQuerySchema,
  PublicA2aRemoteAgentSchema,
  SyncA2aDelegationsRequestSchema,
  SyncA2aDelegationsResponseSchema,
  UpdateA2aRemoteAgentRequestSchema,
  UuidIdSchema,
} from "@/types";

const a2aRemoteAgentRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/agents/:agentId/a2a-delegations",
    {
      schema: {
        operationId: RouteId.GetAgentA2aDelegations,
        description:
          "List external A2A agents explicitly assigned as subagents.",
        tags: ["Agent Delegations"],
        params: z.object({ agentId: UuidIdSchema }),
        response: constructResponseSchema(z.array(A2aDelegationTargetSchema)),
      },
    },
    async ({ params, organizationId, user }, reply) => {
      const agent = await AgentModel.findById(params.agentId, user.id, true);
      if (!agent || agent.organizationId !== organizationId) {
        throw new ApiError(404, "Agent not found");
      }
      try {
        await requireAgentTypePermission({
          userId: user.id,
          organizationId,
          agentType: agent.agentType,
          action: "read",
        });
      } catch {
        throw new ApiError(404, "Agent not found");
      }
      if (agent.agentType === "llm_proxy") {
        throw new ApiError(400, "LLM proxies cannot have subagents");
      }
      const admin = await isAgentTypeAdmin({
        userId: user.id,
        organizationId,
        agentType: agent.agentType,
      });
      if (
        !admin &&
        !(await AgentModel.findById(params.agentId, user.id, false))
      ) {
        throw new ApiError(404, "Agent not found");
      }
      return reply.send(
        await listA2aDelegations(params.agentId, organizationId, {
          userId: user.id,
        }),
      );
    },
  );

  fastify.post(
    "/api/agents/:agentId/a2a-delegations",
    {
      schema: {
        operationId: RouteId.SyncAgentA2aDelegations,
        description:
          "Replace an agent's explicit external A2A subagent assignments.",
        tags: ["Agent Delegations"],
        params: z.object({ agentId: UuidIdSchema }),
        body: SyncA2aDelegationsRequestSchema,
        response: constructResponseSchema(SyncA2aDelegationsResponseSchema),
      },
    },
    async ({ params, body, organizationId, user }, reply) => {
      const agent = await AgentModel.findById(params.agentId, user.id, true);
      if (!agent || agent.organizationId !== organizationId) {
        throw new ApiError(404, "Agent not found");
      }
      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });
      try {
        checker.require(agent.agentType, "update");
      } catch {
        throw new ApiError(404, "Agent not found");
      }
      const userTeamIds = !checker.isAdmin(agent.agentType)
        ? await TeamModel.getUserTeamIds(user.id)
        : [];
      requireAgentModifyPermission({
        checker,
        agentType: agent.agentType,
        agentScope: agent.scope,
        agentAuthorId: agent.authorId,
        agentTeamIds: agent.teams.map((team) => team.id),
        userTeamIds,
        userId: user.id,
      });
      if (agent.agentType === "llm_proxy") {
        throw new ApiError(400, "LLM proxies cannot have subagents");
      }
      const result = await syncA2aDelegations({
        agentId: params.agentId,
        organizationId,
        userId: user.id,
        connectionIds: body.connectionIds,
      });
      clearChatMcpClient(params.agentId);
      return reply.send(result);
    },
  );

  fastify.post(
    "/api/a2a/remote-agents/inspect",
    {
      schema: {
        operationId: RouteId.InspectA2aRemoteAgent,
        description:
          "Resolve and validate an outbound A2A Agent Card without saving it.",
        tags: ["Outbound A2A Agents"],
        body: InspectA2aRemoteAgentRequestSchema,
        response: constructResponseSchema(A2aRemoteAgentInspectionSchema),
      },
    },
    async ({ body }, reply) => reply.send(await inspectA2aRemoteAgent(body)),
  );

  fastify.get(
    "/api/a2a/remote-agents",
    {
      schema: {
        operationId: RouteId.ListA2aRemoteAgents,
        description: "List configured outbound A2A agents.",
        tags: ["Outbound A2A Agents"],
        querystring: ListA2aRemoteAgentsQuerySchema,
        response: constructResponseSchema(z.array(PublicA2aRemoteAgentSchema)),
      },
    },
    async ({ organizationId, user, query }, reply) =>
      reply.send(
        await listA2aRemoteAgents({
          organizationId,
          userId: user.id,
          canManage: await canManageRemoteAgents({
            userId: user.id,
            organizationId,
          }),
          ...query,
        }),
      ),
  );

  fastify.get(
    "/api/a2a/remote-agents/:id",
    {
      schema: {
        operationId: RouteId.GetA2aRemoteAgent,
        description: "Get one configured outbound A2A agent.",
        tags: ["Outbound A2A Agents"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(PublicA2aRemoteAgentSchema),
      },
    },
    async ({ organizationId, user, params }, reply) =>
      reply.send(
        await getA2aRemoteAgent({
          id: params.id,
          organizationId,
          userId: user.id,
          canManage: await canManageRemoteAgents({
            userId: user.id,
            organizationId,
          }),
        }),
      ),
  );

  fastify.get(
    "/api/a2a/remote-agents/:id/runs",
    {
      schema: {
        operationId: RouteId.ListA2aRemoteAgentRuns,
        description:
          "List recent outbound A2A protocol outcomes for one configured external agent.",
        tags: ["Outbound A2A Agents"],
        params: z.object({ id: UuidIdSchema }),
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
        response: constructResponseSchema(z.array(A2aOutboundRunSummarySchema)),
      },
    },
    async ({ organizationId, user, params, query }, reply) => {
      const remoteAgent = await A2aRemoteAgentModel.findByIdVisible({
        id: params.id,
        organizationId,
        userId: user.id,
        canManage: true,
      });
      if (!remoteAgent) {
        throw new ApiError(404, "Outbound A2A agent not found");
      }
      return reply.send(
        await A2aOutboundRunModel.findRecentForRemoteAgent({
          organizationId,
          remoteAgentId: params.id,
          limit: query.limit,
        }),
      );
    },
  );

  fastify.post(
    "/api/a2a/remote-agents",
    {
      schema: {
        operationId: RouteId.CreateA2aRemoteAgent,
        description:
          "Configure an outbound A2A agent and its default connection.",
        tags: ["Outbound A2A Agents"],
        body: CreateA2aRemoteAgentRequestSchema,
        response: constructResponseSchema(PublicA2aRemoteAgentSchema),
      },
    },
    async ({ organizationId, user, body }, reply) =>
      reply.send(
        await createA2aRemoteAgent({
          organizationId,
          authorId: user.id,
          input: body,
        }),
      ),
  );

  fastify.put(
    "/api/a2a/remote-agents/:id",
    {
      schema: {
        operationId: RouteId.UpdateA2aRemoteAgent,
        description:
          "Update an outbound A2A agent, refresh its card, or rotate its credential.",
        tags: ["Outbound A2A Agents"],
        params: z.object({ id: UuidIdSchema }),
        body: UpdateA2aRemoteAgentRequestSchema,
        response: constructResponseSchema(PublicA2aRemoteAgentSchema),
      },
    },
    async ({ organizationId, user, params, body }, reply) =>
      reply.send(
        await updateA2aRemoteAgent({
          id: params.id,
          organizationId,
          actorUserId: user.id,
          input: body,
        }),
      ),
  );

  fastify.delete(
    "/api/a2a/remote-agents/:id",
    {
      schema: {
        operationId: RouteId.DeleteA2aRemoteAgent,
        description:
          "Delete an outbound A2A agent and remove its subagent assignments.",
        tags: ["Outbound A2A Agents"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ organizationId, params }, reply) => {
      const affectedAgentIds = await deleteA2aRemoteAgent({
        id: params.id,
        organizationId,
      });
      for (const agentId of affectedAgentIds) clearChatMcpClient(agentId);
      return reply.send({ success: true });
    },
  );
};

export default a2aRemoteAgentRoutes;

async function canManageRemoteAgents(params: {
  userId: string;
  organizationId: string;
}): Promise<boolean> {
  return userHasPermission(
    params.userId,
    params.organizationId,
    "agentSettings",
    "update",
  );
}
