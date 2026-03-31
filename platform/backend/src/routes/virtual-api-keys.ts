import {
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { userHasPermission } from "@/auth";
import config from "@/config";
import {
  LlmProviderApiKeyModel,
  TeamModel,
  VirtualApiKeyModel,
} from "@/models";
import {
  ApiError,
  constructResponseSchema,
  type ResourceVisibilityScope,
  ResourceVisibilityScopeSchema,
  SelectVirtualApiKeySchema,
  VirtualApiKeyWithParentInfoSchema,
  VirtualApiKeyWithValueSchema,
} from "@/types";

const UpdateVirtualApiKeyResponseSchema = VirtualApiKeyWithValueSchema.omit({
  value: true,
});

const CreateOrUpdateVirtualApiKeyBodySchema = z.object({
  name: z.string().min(1, "Name is required").max(256),
  expiresAt: z.coerce.date().nullable().optional(),
  scope: ResourceVisibilityScopeSchema.default("org"),
  teams: z.array(z.string()).default([]),
});

const virtualApiKeysRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/llm-virtual-keys",
    {
      schema: {
        operationId: RouteId.GetAllVirtualApiKeys,
        description:
          "Get virtual API keys visible to the current user, with parent API key info",
        tags: ["Virtual API Keys"],
        querystring: PaginationQuerySchema.extend({
          search: z.string().trim().min(1).optional(),
          chatApiKeyId: z.string().uuid().optional(),
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(VirtualApiKeyWithParentInfoSchema),
        ),
      },
    },
    async (
      { query: { limit, offset, search, chatApiKeyId }, organizationId, user },
      reply,
    ) => {
      const [userTeamIds, isVirtualKeyAdmin] = await Promise.all([
        TeamModel.getUserTeamIds(user.id),
        userHasPermission(user.id, organizationId, "llmVirtualKey", "admin"),
      ]);

      const result = await VirtualApiKeyModel.findAllByOrganization({
        organizationId,
        pagination: { limit, offset },
        userId: user.id,
        userTeamIds,
        isAdmin: isVirtualKeyAdmin,
        search,
        chatApiKeyId,
      });
      return reply.send(result);
    },
  );

  fastify.get(
    "/api/llm-provider-api-keys/:chatApiKeyId/virtual-keys",
    {
      schema: {
        operationId: RouteId.GetVirtualApiKeys,
        description: "Get visible virtual API keys for an LLM provider API key",
        tags: ["Virtual API Keys"],
        params: z.object({
          chatApiKeyId: z.string().uuid(),
        }),
        response: constructResponseSchema(z.array(SelectVirtualApiKeySchema)),
      },
    },
    async ({ params, organizationId, user }, reply) => {
      const chatApiKey = await LlmProviderApiKeyModel.findById(
        params.chatApiKeyId,
      );
      if (!chatApiKey || chatApiKey.organizationId !== organizationId) {
        throw new ApiError(404, "LLM provider API key not found");
      }

      const [userTeamIds, isVirtualKeyAdmin] = await Promise.all([
        TeamModel.getUserTeamIds(user.id),
        userHasPermission(user.id, organizationId, "llmVirtualKey", "admin"),
      ]);

      const virtualKeys = await VirtualApiKeyModel.findByChatApiKeyId({
        chatApiKeyId: params.chatApiKeyId,
        organizationId,
        userId: user.id,
        userTeamIds,
        isAdmin: isVirtualKeyAdmin,
      });
      return reply.send(virtualKeys);
    },
  );

  fastify.post(
    "/api/llm-provider-api-keys/:chatApiKeyId/virtual-keys",
    {
      schema: {
        operationId: RouteId.CreateVirtualApiKey,
        description:
          "Create a new virtual API key. Returns the full token value once.",
        tags: ["Virtual API Keys"],
        params: z.object({
          chatApiKeyId: z.string().uuid(),
        }),
        body: CreateOrUpdateVirtualApiKeyBodySchema,
        response: constructResponseSchema(VirtualApiKeyWithValueSchema),
      },
    },
    async ({ params, body, organizationId, user }, reply) => {
      const chatApiKey = await LlmProviderApiKeyModel.findById(
        params.chatApiKeyId,
      );
      if (!chatApiKey || chatApiKey.organizationId !== organizationId) {
        throw new ApiError(404, "LLM provider API key not found");
      }

      if (body.expiresAt && body.expiresAt <= new Date()) {
        throw new ApiError(400, "Expiration date must be in the future");
      }

      const [userTeamIds, isVirtualKeyAdmin] = await Promise.all([
        TeamModel.getUserTeamIds(user.id),
        userHasPermission(user.id, organizationId, "llmVirtualKey", "admin"),
      ]);
      await validateVirtualKeyScope({
        scope: body.scope,
        teamIds: body.teams,
        userId: user.id,
        organizationId,
        userTeamIds,
        isAdmin: isVirtualKeyAdmin,
      });

      const count = await VirtualApiKeyModel.countByChatApiKeyId(
        params.chatApiKeyId,
      );
      const maxVirtualKeys = config.llmProxy.maxVirtualKeysPerApiKey;
      if (count >= maxVirtualKeys) {
        throw new ApiError(
          400,
          `Maximum of ${maxVirtualKeys} virtual keys per API key reached`,
        );
      }

      const { virtualKey, value, teams, authorName } =
        await VirtualApiKeyModel.create({
          chatApiKeyId: params.chatApiKeyId,
          name: body.name,
          expiresAt: body.expiresAt ?? null,
          scope: body.scope,
          authorId: user.id,
          teamIds: body.teams,
        });

      return reply.send({ ...virtualKey, value, teams, authorName });
    },
  );

  fastify.patch(
    "/api/llm-provider-api-keys/:chatApiKeyId/virtual-keys/:id",
    {
      schema: {
        operationId: RouteId.UpdateVirtualApiKey,
        description: "Update a virtual API key",
        tags: ["Virtual API Keys"],
        params: z.object({
          chatApiKeyId: z.string().uuid(),
          id: z.string().uuid(),
        }),
        body: CreateOrUpdateVirtualApiKeyBodySchema,
        response: constructResponseSchema(UpdateVirtualApiKeyResponseSchema),
      },
    },
    async ({ params, body, organizationId, user }, reply) => {
      const accessContext = await VirtualApiKeyModel.findAccessContextById(
        params.id,
      );

      if (
        !accessContext ||
        accessContext.chatApiKeyId !== params.chatApiKeyId ||
        accessContext.organizationId !== organizationId
      ) {
        throw new ApiError(404, "Virtual API key not found");
      }

      if (body.expiresAt && body.expiresAt <= new Date()) {
        throw new ApiError(400, "Expiration date must be in the future");
      }

      const [userTeamIds, isVirtualKeyAdmin] = await Promise.all([
        TeamModel.getUserTeamIds(user.id),
        userHasPermission(user.id, organizationId, "llmVirtualKey", "admin"),
      ]);
      await requireVirtualKeyModifyPermission({
        virtualKey: accessContext,
        userId: user.id,
        organizationId,
        userTeamIds,
      });
      await validateVirtualKeyScope({
        scope: body.scope,
        teamIds: body.teams,
        userId: user.id,
        organizationId,
        userTeamIds,
        isAdmin: isVirtualKeyAdmin,
      });

      const updatedVirtualKey = await VirtualApiKeyModel.update({
        id: params.id,
        name: body.name,
        expiresAt: body.expiresAt ?? null,
        scope: body.scope,
        authorId: user.id,
        teamIds: body.teams,
      });

      if (!updatedVirtualKey) {
        throw new ApiError(404, "Virtual API key not found");
      }

      const visibilityMetadata =
        await VirtualApiKeyModel.getVisibilityForVirtualApiKeyIds([params.id]);

      return reply.send({
        ...updatedVirtualKey,
        teams: visibilityMetadata.teams.get(params.id) ?? [],
        authorName: visibilityMetadata.authorName.get(params.id) ?? null,
      });
    },
  );

  fastify.delete(
    "/api/llm-provider-api-keys/:chatApiKeyId/virtual-keys/:id",
    {
      schema: {
        operationId: RouteId.DeleteVirtualApiKey,
        description: "Delete a virtual API key",
        tags: ["Virtual API Keys"],
        params: z.object({
          chatApiKeyId: z.string().uuid(),
          id: z.string().uuid(),
        }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params, organizationId, user }, reply) => {
      const accessContext = await VirtualApiKeyModel.findAccessContextById(
        params.id,
      );

      if (
        !accessContext ||
        accessContext.chatApiKeyId !== params.chatApiKeyId ||
        accessContext.organizationId !== organizationId
      ) {
        throw new ApiError(404, "Virtual API key not found");
      }

      const userTeamIds = await TeamModel.getUserTeamIds(user.id);
      await requireVirtualKeyModifyPermission({
        virtualKey: accessContext,
        userId: user.id,
        organizationId,
        userTeamIds,
      });

      await VirtualApiKeyModel.delete(params.id);
      return reply.send({ success: true });
    },
  );
};

export default virtualApiKeysRoutes;

async function validateVirtualKeyScope(params: {
  scope: ResourceVisibilityScope;
  teamIds: string[];
  userId: string;
  organizationId: string;
  userTeamIds: string[];
  isAdmin: boolean;
}): Promise<void> {
  const { scope, teamIds, userTeamIds, isAdmin } = params;

  if (scope !== "team" && teamIds.length > 0) {
    throw new ApiError(400, "Teams can only be assigned to team-scoped keys");
  }

  if (scope === "team" && teamIds.length === 0) {
    throw new ApiError(400, "At least one team is required for team scope");
  }

  if (scope === "org") {
    if (!isAdmin) {
      throw new ApiError(
        403,
        "You need llmVirtualKey:admin permission to create org-scoped virtual keys",
      );
    }
    return;
  }

  if (scope === "team") {
    const uniqueTeamIds = [...new Set(teamIds)];
    const teams = await TeamModel.findByIds(uniqueTeamIds);
    if (teams.length !== uniqueTeamIds.length) {
      throw new ApiError(400, "One or more selected teams do not exist");
    }

    if (isAdmin) {
      return;
    }

    const userTeamIdSet = new Set(userTeamIds);
    const canManageAllTeams = uniqueTeamIds.every((teamId) =>
      userTeamIdSet.has(teamId),
    );
    if (!canManageAllTeams) {
      throw new ApiError(
        403,
        "You can only assign virtual keys to teams you are a member of",
      );
    }
  }
}

async function requireVirtualKeyModifyPermission(params: {
  virtualKey: {
    scope: ResourceVisibilityScope;
    authorId: string | null;
    teamIds: string[];
  };
  userId: string;
  organizationId: string;
  userTeamIds: string[];
}): Promise<void> {
  const { virtualKey, userId, organizationId, userTeamIds } = params;

  const isAdmin = await userHasPermission(
    userId,
    organizationId,
    "llmVirtualKey",
    "admin",
  );
  if (isAdmin) {
    return;
  }

  switch (virtualKey.scope) {
    case "org":
      throw new ApiError(
        403,
        "Only llmVirtualKey:admin users can manage org-scoped virtual keys",
      );
    case "team": {
      const userTeamIdSet = new Set(userTeamIds);
      const isMemberOfAnyTeam = virtualKey.teamIds.some((teamId) =>
        userTeamIdSet.has(teamId),
      );
      if (!isMemberOfAnyTeam) {
        throw new ApiError(
          403,
          "You can only manage virtual keys in teams you are a member of",
        );
      }
      return;
    }
    case "personal":
      if (virtualKey.authorId !== userId) {
        throw new ApiError(
          403,
          "You can only manage your own personal virtual keys",
        );
      }
      return;
  }
}
