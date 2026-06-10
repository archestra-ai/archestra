import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  getAgentTypePermissionChecker,
  requireAgentModifyPermission,
} from "@/auth";
import { AgentModel, AgentVersionModel, TeamModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  PromptSnapshotV1Schema,
  SelectAgentSchema,
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
          // Either the live agent prompt ("current") or another version's UUID.
          // Constrained here so a malformed value is rejected at validation
          // instead of reaching a uuid column lookup and surfacing as a 500.
          against: z.union([z.literal("current"), UuidIdSchema]),
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

  fastify.post(
    "/api/agents/:id/versions/:versionId/restore",
    {
      schema: {
        operationId: RouteId.RestoreAgentVersion,
        description:
          "Restore an agent's system prompt to a prior version. Writes a new version row with source='restore'.",
        tags: ["Agent Versions"],
        params: z.object({
          id: UuidIdSchema,
          versionId: UuidIdSchema,
        }),
        body: z.object({}),
        response: constructResponseSchema(
          z.object({
            agent: SelectAgentSchema,
            restoredVersion: z
              .object({
                id: z.string(),
                versionNumber: z.number(),
                source: z.literal("restore"),
                createdAt: z.string(),
              })
              .nullable(),
          }),
        ),
      },
    },
    async ({ params: { id, versionId }, user, organizationId }, reply) => {
      // Fetch agent with admin=true so we can evaluate type-based permissions
      const agent = await AgentModel.findById(id, user.id, true);
      if (!agent || agent.organizationId !== organizationId) {
        throw new ApiError(404, "Agent not found");
      }

      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });

      // Restore requires update permission (return 404 to avoid leaking existence)
      try {
        checker.require(agent.agentType, "update");
      } catch {
        throw new ApiError(404, "Agent not found");
      }

      // Scope-based modify check (mirrors UpdateAgent logic)
      const userTeamIds = !checker.isAdmin(agent.agentType)
        ? await TeamModel.getUserTeamIds(user.id)
        : [];

      requireAgentModifyPermission({
        checker,
        agentType: agent.agentType,
        agentScope: agent.scope,
        agentAuthorId: agent.authorId,
        agentTeamIds: agent.teams.map((t) => t.id),
        userTeamIds,
        userId: user.id,
      });

      // Fetch the target version and verify it belongs to this agent
      const version = await AgentVersionModel.findById(versionId);
      if (!version || version.agentId !== id) {
        throw new ApiError(404, "Version not found");
      }

      const snapshot = PromptSnapshotV1Schema.parse(version.snapshot);

      // Apply the restore by writing the historical prompt back to the agent
      const updated = await AgentModel.update(id, {
        systemPrompt: snapshot.systemPrompt,
      });
      if (!updated) {
        throw new ApiError(404, "Agent not found");
      }

      // Record a new version row for the restore (dedup: returns null when prompt
      // already matches current, e.g. restoring the version that is already live)
      const newVersion = await AgentVersionModel.record({
        agentId: id,
        organizationId,
        systemPrompt: snapshot.systemPrompt,
        source: "restore",
        userId: user.id,
        userName: user.name,
      });

      return reply.send({
        agent: updated,
        restoredVersion: newVersion
          ? {
              id: newVersion.id,
              versionNumber: newVersion.versionNumber,
              source: "restore" as const,
              createdAt: new Date().toISOString(),
            }
          : null,
      });
    },
  );
};

export default agentVersionRoutes;
