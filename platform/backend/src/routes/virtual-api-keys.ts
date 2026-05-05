import {
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
  type SupportedProvider,
  SupportedProvidersSchema,
} from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { userHasPermission } from "@/auth";
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
  type User,
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
  providerApiKeys: z
    .array(
      z.object({
        provider: SupportedProvidersSchema,
        providerApiKeyId: z.string().uuid(),
      }),
    )
    .min(1, "At least one provider API key is required"),
});

const CreateVirtualApiKeyBodySchema = CreateOrUpdateVirtualApiKeyBodySchema;

const virtualApiKeysRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/llm-virtual-keys",
    {
      schema: {
        operationId: RouteId.GetAllVirtualApiKeys,
        description:
          "Get virtual API keys visible to the current user, with provider key mappings",
        tags: ["Virtual API Keys"],
        querystring: PaginationQuerySchema.extend({
          search: z.string().trim().min(1).optional(),
          providerApiKeyId: z.string().uuid().optional(),
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(VirtualApiKeyWithParentInfoSchema),
        ),
      },
    },
    async (
      {
        query: { limit, offset, search, providerApiKeyId },
        organizationId,
        user,
      },
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
        providerApiKeyId,
      });
      return reply.send(result);
    },
  );

  fastify.post(
    "/api/llm-virtual-keys",
    {
      schema: {
        operationId: RouteId.CreateVirtualApiKey,
        description:
          "Create a new virtual API key. Returns the full token value once.",
        tags: ["Virtual API Keys"],
        body: CreateVirtualApiKeyBodySchema,
        response: constructResponseSchema(VirtualApiKeyWithValueSchema),
      },
    },
    async ({ body, organizationId, user }, reply) => {
      const response = await createVirtualApiKey({
        body,
        organizationId,
        user,
      });
      return reply.send(response);
    },
  );

  fastify.patch(
    "/api/llm-virtual-keys/:id",
    {
      schema: {
        operationId: RouteId.UpdateVirtualApiKey,
        description: "Update a virtual API key",
        tags: ["Virtual API Keys"],
        params: z.object({
          id: z.string().uuid(),
        }),
        body: CreateOrUpdateVirtualApiKeyBodySchema,
        response: constructResponseSchema(UpdateVirtualApiKeyResponseSchema),
      },
    },
    async ({ params, body, organizationId, user }, reply) => {
      const response = await updateVirtualApiKey({
        id: params.id,
        body,
        organizationId,
        user,
      });
      return reply.send(response);
    },
  );

  fastify.delete(
    "/api/llm-virtual-keys/:id",
    {
      schema: {
        operationId: RouteId.DeleteVirtualApiKey,
        description: "Delete a virtual API key",
        tags: ["Virtual API Keys"],
        params: z.object({
          id: z.string().uuid(),
        }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params, organizationId, user }, reply) => {
      const response = await deleteVirtualApiKey({
        id: params.id,
        organizationId,
        user,
      });
      return reply.send(response);
    },
  );
};

export default virtualApiKeysRoutes;

async function createVirtualApiKey(params: {
  body: z.infer<typeof CreateOrUpdateVirtualApiKeyBodySchema>;
  organizationId: string;
  user: User;
}): Promise<z.infer<typeof VirtualApiKeyWithValueSchema>> {
  const { body, organizationId, user } = params;

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
  await validateProviderApiKeys({
    mappings: body.providerApiKeys,
    organizationId,
  });

  const { virtualKey, value, teams, authorName, providerApiKeys } =
    await VirtualApiKeyModel.create({
      organizationId,
      name: body.name,
      expiresAt: body.expiresAt ?? null,
      scope: body.scope,
      authorId: user.id,
      teamIds: body.teams,
      providerApiKeys: body.providerApiKeys,
    });

  return {
    ...virtualKey,
    value,
    teams,
    authorName,
    providerApiKeys,
  };
}

async function updateVirtualApiKey(params: {
  id: string;
  body: z.infer<typeof CreateOrUpdateVirtualApiKeyBodySchema>;
  organizationId: string;
  user: User;
}): Promise<z.infer<typeof UpdateVirtualApiKeyResponseSchema>> {
  const { id, body, organizationId, user } = params;

  const accessContext = await VirtualApiKeyModel.findAccessContextById(id);

  if (!accessContext || accessContext.organizationId !== organizationId) {
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
  await validateProviderApiKeys({
    mappings: body.providerApiKeys,
    organizationId,
  });

  const updatedVirtualKey = await VirtualApiKeyModel.update({
    id,
    name: body.name,
    expiresAt: body.expiresAt ?? null,
    scope: body.scope,
    authorId: user.id,
    teamIds: body.teams,
    providerApiKeys: body.providerApiKeys,
  });

  if (!updatedVirtualKey) {
    throw new ApiError(404, "Virtual API key not found");
  }

  const visibilityMetadata =
    await VirtualApiKeyModel.getVisibilityForVirtualApiKeyIds([id]);
  const providerApiKeys = await VirtualApiKeyModel.getProviderApiKeys(id);

  return {
    ...updatedVirtualKey,
    teams: visibilityMetadata.teams.get(id) ?? [],
    authorName: visibilityMetadata.authorName.get(id) ?? null,
    providerApiKeys,
  };
}

async function deleteVirtualApiKey(params: {
  id: string;
  organizationId: string;
  user: User;
}): Promise<{ success: boolean }> {
  const { id, organizationId, user } = params;

  const accessContext = await VirtualApiKeyModel.findAccessContextById(id);

  if (!accessContext || accessContext.organizationId !== organizationId) {
    throw new ApiError(404, "Virtual API key not found");
  }

  const userTeamIds = await TeamModel.getUserTeamIds(user.id);
  await requireVirtualKeyModifyPermission({
    virtualKey: accessContext,
    userId: user.id,
    organizationId,
    userTeamIds,
  });

  await VirtualApiKeyModel.delete(id);
  return { success: true };
}

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

async function validateProviderApiKeys(params: {
  mappings: Array<{ provider: SupportedProvider; providerApiKeyId: string }>;
  organizationId: string;
}): Promise<void> {
  const { mappings, organizationId } = params;
  if (mappings.length === 0) {
    return;
  }

  const providers = new Set<SupportedProvider>();
  const apiKeys = await LlmProviderApiKeyModel.findByIds(
    mappings.map((mapping) => mapping.providerApiKeyId),
  );
  const apiKeysById = new Map(apiKeys.map((apiKey) => [apiKey.id, apiKey]));

  for (const mapping of mappings) {
    if (providers.has(mapping.provider)) {
      throw new ApiError(
        400,
        `Only one provider API key can be mapped for provider "${mapping.provider}".`,
      );
    }
    providers.add(mapping.provider);

    const apiKey = apiKeysById.get(mapping.providerApiKeyId);
    if (!apiKey || apiKey.organizationId !== organizationId) {
      throw new ApiError(404, "LLM provider API key not found");
    }
    if (apiKey.provider !== mapping.provider) {
      throw new ApiError(
        400,
        `Provider API key "${apiKey.name}" is for provider "${apiKey.provider}", not "${mapping.provider}".`,
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
