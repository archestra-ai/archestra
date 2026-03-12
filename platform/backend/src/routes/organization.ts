import {
  AUTO_PROVISIONED_INVITATION_STATUS,
  addNomicTaskPrefix,
  EMBEDDING_COMPATIBLE_PROVIDERS,
  getEmbeddingDimensions,
  RouteId,
} from "@shared";
import { and, eq, inArray, like } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import OpenAI from "openai";
import { z } from "zod";
import db, { schema } from "@/database";
import { resolveApiKeyFromChatApiKey } from "@/knowledge-base/kb-llm-client";
import {
  AgentModel,
  ChatApiKeyModel,
  InteractionModel,
  InvitationModel,
  KbDocumentModel,
  KnowledgeBaseConnectorModel,
  McpToolCallModel,
  MemberModel,
  OrganizationModel,
  UserModel,
  UserTokenModel,
} from "@/models";
import {
  ApiError,
  CompleteOnboardingSchema,
  constructResponseSchema,
  PublicAppearanceSchema,
  SelectOrganizationSchema,
  UpdateAgentSettingsSchema,
  UpdateAppearanceSchema,
  UpdateKnowledgeSettingsSchema,
  UpdateLlmSettingsSchema,
  UpdateSecuritySettingsSchema,
} from "@/types";

const organizationRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/organization",
    {
      schema: {
        operationId: RouteId.GetOrganization,
        description: "Get organization details",
        tags: ["Organization"],
        response: constructResponseSchema(SelectOrganizationSchema),
      },
    },
    async ({ organizationId }, reply) => {
      const organization = await OrganizationModel.getById(organizationId);

      if (!organization) {
        throw new ApiError(404, "Organization not found");
      }

      return reply.send(organization);
    },
  );

  fastify.patch(
    "/api/organization/appearance",
    {
      schema: {
        operationId: RouteId.UpdateAppearance,
        description: "Update appearance settings (theme, logo, fonts)",
        tags: ["Organization"],
        body: UpdateAppearanceSchema,
        response: constructResponseSchema(SelectOrganizationSchema),
      },
    },
    async ({ organizationId, body }, reply) => {
      const organization = await OrganizationModel.patch(organizationId, body);

      if (!organization) {
        throw new ApiError(404, "Organization not found");
      }

      return reply.send(organization);
    },
  );

  fastify.patch(
    "/api/organization/security-settings",
    {
      schema: {
        operationId: RouteId.UpdateSecuritySettings,
        description:
          "Update security settings (global tool policy, chat file uploads)",
        tags: ["Organization"],
        body: UpdateSecuritySettingsSchema,
        response: constructResponseSchema(SelectOrganizationSchema),
      },
    },
    async ({ organizationId, body }, reply) => {
      const organization = await OrganizationModel.patch(organizationId, body);

      if (!organization) {
        throw new ApiError(404, "Organization not found");
      }

      return reply.send(organization);
    },
  );

  fastify.patch(
    "/api/organization/llm-settings",
    {
      schema: {
        operationId: RouteId.UpdateLlmSettings,
        description:
          "Update LLM settings (TOON compression, compression scope, limit cleanup interval)",
        tags: ["Organization"],
        body: UpdateLlmSettingsSchema,
        response: constructResponseSchema(SelectOrganizationSchema),
      },
    },
    async ({ organizationId, body }, reply) => {
      const organization = await OrganizationModel.patch(organizationId, body);

      if (!organization) {
        throw new ApiError(404, "Organization not found");
      }

      return reply.send(organization);
    },
  );

  fastify.patch(
    "/api/organization/agent-settings",
    {
      schema: {
        operationId: RouteId.UpdateAgentSettings,
        description: "Update agent settings (default model, default agent)",
        tags: ["Organization"],
        body: UpdateAgentSettingsSchema,
        response: constructResponseSchema(SelectOrganizationSchema),
      },
    },
    async ({ organizationId, body }, reply) => {
      if (body.defaultLlmApiKeyId) {
        const apiKey = await ChatApiKeyModel.findById(body.defaultLlmApiKeyId);
        if (!apiKey || apiKey.organizationId !== organizationId) {
          throw new ApiError(404, "API key not found");
        }
      }

      if (body.defaultAgentId) {
        const agent = await AgentModel.findById(body.defaultAgentId);
        if (!agent || agent.organizationId !== organizationId) {
          throw new ApiError(404, "Agent not found");
        }
      }

      const organization = await OrganizationModel.patch(organizationId, body);

      if (!organization) {
        throw new ApiError(404, "Organization not found");
      }

      return reply.send(organization);
    },
  );

  fastify.patch(
    "/api/organization/knowledge-settings",
    {
      schema: {
        operationId: RouteId.UpdateKnowledgeSettings,
        description: "Update knowledge settings (embedding model)",
        tags: ["Organization"],
        body: UpdateKnowledgeSettingsSchema,
        response: constructResponseSchema(SelectOrganizationSchema),
      },
    },
    async ({ organizationId, body }, reply) => {
      // Embedding model is locked once both key and model have been saved
      if (body.embeddingModel) {
        const currentOrg = await OrganizationModel.getById(organizationId);
        if (
          currentOrg?.embeddingChatApiKeyId &&
          currentOrg?.embeddingModel &&
          body.embeddingModel !== currentOrg.embeddingModel
        ) {
          throw new ApiError(
            400,
            "Embedding model cannot be changed once configured. Changing models requires re-embedding all documents.",
          );
        }
      }

      // Validate embedding API key uses an embedding-compatible provider
      if (body.embeddingChatApiKeyId) {
        const chatApiKey = await ChatApiKeyModel.findById(
          body.embeddingChatApiKeyId,
        );
        if (!chatApiKey) {
          throw new ApiError(404, "Embedding API key not found");
        }
        if (!EMBEDDING_COMPATIBLE_PROVIDERS.has(chatApiKey.provider)) {
          throw new ApiError(
            400,
            "Embedding API key must use a compatible provider (OpenAI or Ollama)",
          );
        }
      }

      const organization = await OrganizationModel.patch(organizationId, body);

      if (!organization) {
        throw new ApiError(404, "Organization not found");
      }

      return reply.send(organization);
    },
  );

  fastify.post(
    "/api/organization/knowledge-settings/drop-embedding",
    {
      schema: {
        operationId: RouteId.DropEmbeddingConfig,
        description:
          "Drop the embedding configuration, deleting all KB documents and resetting connector checkpoints",
        tags: ["Organization"],
        response: constructResponseSchema(SelectOrganizationSchema),
      },
    },
    async ({ organizationId }, reply) => {
      const currentOrg = await OrganizationModel.getById(organizationId);
      if (!currentOrg?.embeddingChatApiKeyId || !currentOrg?.embeddingModel) {
        throw new ApiError(
          400,
          "Embedding configuration is not locked — nothing to drop",
        );
      }

      // Delete all KB documents (chunks cascade via FK)
      await KbDocumentModel.deleteByOrganization(organizationId);

      // Reset connector checkpoints so next sync does a full re-ingest
      await KnowledgeBaseConnectorModel.resetCheckpointsByOrganization(
        organizationId,
      );

      // Clear embedding config
      const organization = await OrganizationModel.patch(organizationId, {
        embeddingModel: null,
        embeddingChatApiKeyId: null,
      });

      if (!organization) {
        throw new ApiError(404, "Organization not found");
      }

      return reply.send(organization);
    },
  );

  fastify.post(
    "/api/organization/knowledge-settings/test-embedding",
    {
      schema: {
        operationId: RouteId.TestEmbeddingConnection,
        description: "Test the embedding connection by embedding a sample text",
        tags: ["Organization"],
        body: z.object({
          embeddingChatApiKeyId: z.string().uuid(),
          embeddingModel: z.string().min(1),
        }),
        response: constructResponseSchema(
          z.object({
            success: z.boolean(),
            error: z.string().optional(),
          }),
        ),
      },
    },
    async ({ body }, reply) => {
      // Validate API key exists and uses an embedding-compatible provider
      const chatApiKey = await ChatApiKeyModel.findById(
        body.embeddingChatApiKeyId,
      );
      if (!chatApiKey) {
        throw new ApiError(404, "API key not found");
      }
      if (!EMBEDDING_COMPATIBLE_PROVIDERS.has(chatApiKey.provider)) {
        throw new ApiError(
          400,
          "Embedding API key must use a compatible provider (OpenAI or Ollama)",
        );
      }

      // Resolve the actual secret
      const resolved = await resolveApiKeyFromChatApiKey(
        body.embeddingChatApiKeyId,
      );
      if (!resolved) {
        return reply.send({
          success: false,
          error: "Could not resolve API key secret",
        });
      }

      try {
        const client = new OpenAI({
          apiKey: resolved.apiKey,
          baseURL: resolved.baseUrl ?? undefined,
        });

        const response = await client.embeddings.create({
          model: body.embeddingModel,
          input: [
            addNomicTaskPrefix(
              body.embeddingModel,
              "hello world",
              "search_document",
            ),
          ],
          ...(body.embeddingModel.includes("nomic")
            ? {}
            : { dimensions: getEmbeddingDimensions(body.embeddingModel) }),
        });

        if (response.data.length > 0) {
          return reply.send({ success: true });
        }

        return reply.send({
          success: false,
          error: "No embedding data returned",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return reply.send({ success: false, error: message });
      }
    },
  );

  fastify.post(
    "/api/organization/complete-onboarding",
    {
      schema: {
        operationId: RouteId.CompleteOnboarding,
        description: "Mark organization onboarding as complete",
        tags: ["Organization"],
        body: CompleteOnboardingSchema,
        response: constructResponseSchema(SelectOrganizationSchema),
      },
    },
    async ({ organizationId, body }, reply) => {
      const organization = await OrganizationModel.patch(organizationId, body);

      if (!organization) {
        throw new ApiError(404, "Organization not found");
      }

      return reply.send(organization);
    },
  );

  fastify.get(
    "/api/organization/onboarding-status",
    {
      schema: {
        operationId: RouteId.GetOnboardingStatus,
        description: "Check if organization onboarding is complete",
        tags: ["Organization"],
        response: constructResponseSchema(
          z.object({
            hasLlmProxyLogs: z.boolean(),
            hasMcpGatewayLogs: z.boolean(),
          }),
        ),
      },
    },
    async (_request, reply) => {
      // Check if onboarding is complete by checking if there are any logs
      const interactionCount = await InteractionModel.getCount();
      const mcpToolCallCount = await McpToolCallModel.getCount();

      return reply.send({
        hasLlmProxyLogs: interactionCount > 0,
        hasMcpGatewayLogs: mcpToolCallCount > 0,
      });
    },
  );

  /**
   * Get signup status for organization members.
   * Returns members that don't have an account record (auto-provisioned, haven't signed up),
   * along with the provider they were auto-provisioned from.
   */
  fastify.get(
    "/api/organization/members/signup-status",
    {
      schema: {
        operationId: RouteId.GetMemberSignupStatus,
        description:
          "Get which members have completed signup (have an account record)",
        tags: ["Organization"],
        response: constructResponseSchema(
          z.object({
            pendingSignupMembers: z.array(
              z.object({
                userId: z.string(),
                provider: z.string().nullable(),
                invitationId: z.string().nullable(),
              }),
            ),
          }),
        ),
      },
    },
    async ({ organizationId }, reply) => {
      // Get all member user IDs for this organization
      const members = await db
        .select({ userId: schema.membersTable.userId })
        .from(schema.membersTable)
        .where(eq(schema.membersTable.organizationId, organizationId));

      if (members.length === 0) {
        return reply.send({ pendingSignupMembers: [] });
      }

      const memberUserIds = members.map((m) => m.userId);

      // Find which of these users have an account record
      const usersWithAccounts = await db
        .select({ userId: schema.accountsTable.userId })
        .from(schema.accountsTable)
        .where(inArray(schema.accountsTable.userId, memberUserIds));

      const hasAccountSet = new Set(usersWithAccounts.map((a) => a.userId));
      const pendingUserIds = memberUserIds.filter(
        (id) => !hasAccountSet.has(id),
      );

      if (pendingUserIds.length === 0) {
        return reply.send({ pendingSignupMembers: [] });
      }

      // Look up auto-provisioned invitations to get provider and invitation ID
      const invitations = await db
        .select({
          id: schema.invitationsTable.id,
          email: schema.invitationsTable.email,
          status: schema.invitationsTable.status,
        })
        .from(schema.invitationsTable)
        .where(
          like(
            schema.invitationsTable.status,
            `${AUTO_PROVISIONED_INVITATION_STATUS}%`,
          ),
        );

      // Build email → { provider, invitationId } map
      const emailToInvitation = new Map<
        string,
        { provider: string | null; invitationId: string }
      >();
      for (const inv of invitations) {
        const parts = inv.status.split(":");
        emailToInvitation.set(inv.email, {
          provider: parts.length === 2 ? parts[1] : null,
          invitationId: inv.id,
        });
      }

      // Get emails for pending users
      const pendingUsers = await db
        .select({ id: schema.usersTable.id, email: schema.usersTable.email })
        .from(schema.usersTable)
        .where(inArray(schema.usersTable.id, pendingUserIds));

      const pendingSignupMembers = pendingUsers.map((u) => {
        const inv = emailToInvitation.get(u.email);
        return {
          userId: u.id,
          provider: inv?.provider ?? null,
          invitationId: inv?.invitationId ?? null,
        };
      });

      return reply.send({ pendingSignupMembers });
    },
  );

  /**
   * Delete an auto-provisioned member who hasn't completed signup.
   * Removes the member, invitation, user token, and user record.
   */
  fastify.delete(
    "/api/organization/members/:userId/pending-signup",
    {
      schema: {
        operationId: RouteId.DeletePendingSignupMember,
        description:
          "Delete an auto-provisioned member who hasn't completed signup",
        tags: ["Organization"],
        params: z.object({ userId: z.string() }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ organizationId, params }, reply) => {
      const { userId } = params;

      // Verify user has no account (is actually pending signup)
      const [account] = await db
        .select({ userId: schema.accountsTable.userId })
        .from(schema.accountsTable)
        .where(eq(schema.accountsTable.userId, userId))
        .limit(1);

      if (account) {
        throw new ApiError(
          400,
          "Cannot delete a member who has already completed signup",
        );
      }

      // Get user email to find their invitation
      const user = await UserModel.getById(userId);
      if (!user) {
        throw new ApiError(404, "User not found");
      }

      // Delete invitation(s) with auto-provisioned status for this email
      const invitations = await db
        .select({ id: schema.invitationsTable.id })
        .from(schema.invitationsTable)
        .where(
          and(
            eq(schema.invitationsTable.email, user.email),
            like(
              schema.invitationsTable.status,
              `${AUTO_PROVISIONED_INVITATION_STATUS}%`,
            ),
          ),
        );

      for (const inv of invitations) {
        await InvitationModel.delete(inv.id);
      }

      // Delete personal tokens
      await UserTokenModel.deleteByUserAndOrg(userId, organizationId);

      // Delete member record
      await MemberModel.deleteByMemberOrUserId(userId, organizationId);

      // Delete user record (no other memberships since auto-provisioned)
      await UserModel.delete(userId);

      return reply.send({ success: true });
    },
  );

  fastify.get(
    "/api/organization/members",
    {
      schema: {
        operationId: RouteId.GetOrganizationMembers,
        description: "Get all members of the organization",
        tags: ["Organization"],
        response: constructResponseSchema(
          z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              email: z.string(),
            }),
          ),
        ),
      },
    },
    async ({ organizationId }, reply) => {
      const members = await MemberModel.findAllByOrganization(organizationId);
      return reply.send(members);
    },
  );

  fastify.get(
    "/api/organization/appearance",
    {
      schema: {
        operationId: RouteId.GetPublicAppearance,
        description:
          "Get public appearance settings (theme, logo, font) for unauthenticated pages",
        tags: ["Organization"],
        response: constructResponseSchema(PublicAppearanceSchema),
      },
    },
    async (_request, reply) => {
      return reply.send(await OrganizationModel.getPublicAppearance());
    },
  );
};

export default organizationRoutes;
