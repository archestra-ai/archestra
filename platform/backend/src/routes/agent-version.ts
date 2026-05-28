import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { getAgentTypePermissionChecker } from "@/auth";
import { AgentModel, AgentVersionModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  PromptSnapshotV1Schema,
  UuidIdSchema,
} from "@/types";

const agentVersionRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/agents/:id/versions",
    {
      schema: {
        operationId: RouteId.GetAgentVersions,
        description: "List prompt version history for an agent",
        tags: ["Agent Versions"],
        params: z.object({
          id: UuidIdSchema,
        }),
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: constructResponseSchema(
          z.object({
            data: z.array(
              z.object({
                id: z.string(),
                versionNumber: z.number(),
                source: z.enum(["create", "update", "restore"]),
                createdBy: z.string().nullable(),
                createdByName: z.string().nullable(),
                createdAt: z.string(),
                promptPreview: z.string().nullable(),
              }),
            ),
            total: z.number(),
          }),
        ),
      },
    },
    async (
      { params: { id }, query: { limit, offset }, user, organizationId },
      reply,
    ) => {
      const agent = await AgentModel.findById(id, user.id, true);
      if (!agent || agent.organizationId !== organizationId) {
        throw new ApiError(404, "Agent not found");
      }

      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });
      try {
        checker.require(agent.agentType, "read");
      } catch {
        throw new ApiError(404, "Agent not found");
      }

      const { versions, total } = await AgentVersionModel.list(id, {
        limit,
        offset,
      });

      return reply.send({
        data: versions.map((v) => {
          const snapshot = PromptSnapshotV1Schema.parse(v.snapshot);
          const promptPreview =
            snapshot.systemPrompt !== null
              ? snapshot.systemPrompt.slice(0, 100)
              : null;
          return {
            id: v.id,
            versionNumber: v.versionNumber,
            source: v.source as "create" | "update" | "restore",
            createdBy: v.createdBy,
            createdByName: v.createdByName,
            createdAt: v.createdAt.toISOString(),
            promptPreview,
          };
        }),
        total,
      });
    },
  );

  fastify.get(
    "/api/agents/:id/versions/:versionId",
    {
      schema: {
        operationId: RouteId.GetAgentVersion,
        description: "Get a single prompt version snapshot",
        tags: ["Agent Versions"],
        params: z.object({
          id: UuidIdSchema,
          versionId: UuidIdSchema,
        }),
        response: constructResponseSchema(
          z.object({
            id: z.string(),
            agentId: z.string(),
            versionNumber: z.number(),
            snapshot: PromptSnapshotV1Schema,
            source: z.enum(["create", "update", "restore"]),
            createdBy: z.string().nullable(),
            createdByName: z.string().nullable(),
            createdAt: z.string(),
          }),
        ),
      },
    },
    async ({ params: { id, versionId }, user, organizationId }, reply) => {
      const agent = await AgentModel.findById(id, user.id, true);
      if (!agent || agent.organizationId !== organizationId) {
        throw new ApiError(404, "Agent not found");
      }

      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });
      try {
        checker.require(agent.agentType, "read");
      } catch {
        throw new ApiError(404, "Agent not found");
      }

      const version = await AgentVersionModel.findById(versionId);
      if (!version || version.agentId !== id) {
        throw new ApiError(404, "Version not found");
      }

      const snapshot = PromptSnapshotV1Schema.parse(version.snapshot);

      return reply.send({
        id: version.id,
        agentId: version.agentId,
        versionNumber: version.versionNumber,
        snapshot,
        source: version.source as "create" | "update" | "restore",
        createdBy: version.createdBy,
        createdByName: version.createdByName,
        createdAt: version.createdAt.toISOString(),
      });
    },
  );

  fastify.get(
    "/api/agents/:id/versions/:versionId/diff",
    {
      schema: {
        operationId: RouteId.GetAgentVersionDiff,
        description:
          "Diff a prompt version against another version or the current agent prompt",
        tags: ["Agent Versions"],
        params: z.object({
          id: UuidIdSchema,
          versionId: UuidIdSchema,
        }),
        querystring: z.object({
          against: z.string().min(1),
        }),
        response: constructResponseSchema(
          z.object({
            base: z.object({
              versionNumber: z.number(),
              systemPrompt: z.string().nullable(),
              createdAt: z.string(),
            }),
            target: z.object({
              versionNumber: z.number().nullable(),
              systemPrompt: z.string().nullable(),
              label: z.string(),
            }),
            changed: z.boolean(),
          }),
        ),
      },
    },
    async (
      { params: { id, versionId }, query: { against }, user, organizationId },
      reply,
    ) => {
      const agent = await AgentModel.findById(id, user.id, true);
      if (!agent || agent.organizationId !== organizationId) {
        throw new ApiError(404, "Agent not found");
      }

      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });
      try {
        checker.require(agent.agentType, "read");
      } catch {
        throw new ApiError(404, "Agent not found");
      }

      const baseVersion = await AgentVersionModel.findById(versionId);
      if (!baseVersion || baseVersion.agentId !== id) {
        throw new ApiError(404, "Version not found");
      }

      const baseSnapshot = PromptSnapshotV1Schema.parse(baseVersion.snapshot);

      let targetSystemPrompt: string | null;
      let targetVersionNumber: number | null;
      let targetLabel: string;

      if (against === "current") {
        targetSystemPrompt = agent.systemPrompt;
        targetVersionNumber = null;
        targetLabel = "current";
      } else {
        const targetVersion = await AgentVersionModel.findById(against);
        if (!targetVersion || targetVersion.agentId !== id) {
          throw new ApiError(404, "Target version not found");
        }
        const targetSnapshot = PromptSnapshotV1Schema.parse(
          targetVersion.snapshot,
        );
        targetSystemPrompt = targetSnapshot.systemPrompt;
        targetVersionNumber = targetVersion.versionNumber;
        targetLabel = `v${targetVersion.versionNumber}`;
      }

      return reply.send({
        base: {
          versionNumber: baseVersion.versionNumber,
          systemPrompt: baseSnapshot.systemPrompt,
          createdAt: baseVersion.createdAt.toISOString(),
        },
        target: {
          versionNumber: targetVersionNumber,
          systemPrompt: targetSystemPrompt,
          label: targetLabel,
        },
        changed: baseSnapshot.systemPrompt !== targetSystemPrompt,
      });
    },
  );
};

export default agentVersionRoutes;
