// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
import {
  calculatePaginationMeta,
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { userHasPermission } from "@/auth/utils";
import { enterpriseTier } from "@/enterprise-tier";
import {
  didKnowledgeSourceAclInputsChange,
  isTeamScopedWithoutTeams,
  knowledgeSourceAccessControlService,
} from "@/knowledge-base";
import { resolveConnectorCredentials } from "@/knowledge-base/connector-credentials";
import { getConnector } from "@/knowledge-base/connectors/registry";
import logger from "@/logging";
import {
  AgentConnectorAssignmentModel,
  AgentKnowledgeBaseModel,
  AgentModel,
  ConnectorRunModel,
  GithubAppConfigModel,
  KbDocumentModel,
  KnowledgeBaseConnectorModel,
  KnowledgeBaseModel,
  TaskModel,
} from "@/models";
import { secretManager } from "@/secrets-manager";
import { assertCanAssignEnvironment } from "@/services/environments/environment";
import { taskQueueService } from "@/task-queue";
import {
  ApiError,
  type ConnectorConfig,
  ConnectorConfigSchema,
  ConnectorCredentialsSchema,
  type ConnectorType,
  ConnectorTypeSchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  KnowledgeSourceVisibilitySchema,
  SelectConnectorRunDetailSchema,
  SelectConnectorRunListSchema,
  SelectKbDocumentSchema,
  SelectKnowledgeBaseConnectorSchema,
  SelectKnowledgeBaseSchema,
} from "@/types";

const AssignedAgentSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  agentType: z.string(),
});

const KnowledgeBaseWithConnectorsSchema = SelectKnowledgeBaseSchema.extend({
  connectors: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      connectorType: ConnectorTypeSchema,
    }),
  ),
  totalDocsIndexed: z.number(),
  assignedAgents: z.array(AssignedAgentSummarySchema),
});

const KnowledgeBaseDocumentListItemSchema = SelectKbDocumentSchema.omit({
  content: true,
}).extend({
  connectorType: ConnectorTypeSchema,
});

const KnowledgeBaseDocumentDetailSchema = SelectKbDocumentSchema.extend({
  connectorType: ConnectorTypeSchema,
});

const knowledgeBaseRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // ===== Knowledge Base CRUD =====

  fastify.get(
    "/api/knowledge-bases",
    {
      schema: {
        operationId: RouteId.GetKnowledgeBases,
        description: "List all knowledge bases for the organization",
        tags: ["Knowledge Bases"],
        querystring: PaginationQuerySchema.extend({
          search: z.string().optional(),
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(KnowledgeBaseWithConnectorsSchema),
        ),
      },
    },
    async (
      { query: { limit, offset, search }, organizationId, user },
      reply,
    ) => {
      const access =
        await knowledgeSourceAccessControlService.buildAccessControlContext({
          userId: user.id,
          organizationId,
        });
      const [knowledgeBases, total] = await Promise.all([
        KnowledgeBaseModel.findByOrganization({
          organizationId,
          limit,
          offset,
          search,
        }),
        KnowledgeBaseModel.countByOrganization({
          organizationId,
          search,
        }),
      ]);

      const kbIds = knowledgeBases.map((kb) => kb.id);
      const [allConnectors, docsIndexedByKbId, agentIdsByKbId] =
        await Promise.all([
          KnowledgeBaseConnectorModel.findByKnowledgeBaseIds(kbIds, {
            canReadAll: access.canReadAll,
            viewerTeamIds: access.teamIds,
          }),
          KbDocumentModel.countByKnowledgeBaseIds(kbIds),
          AgentKnowledgeBaseModel.getAgentIdsForKnowledgeBases(kbIds),
        ]);

      // Collect all unique agent IDs and batch-fetch their names
      const allAgentIds = [...new Set([...agentIdsByKbId.values()].flat())];
      const agentDetailsMap = new Map<
        string,
        { id: string; name: string; agentType: string }
      >();
      if (allAgentIds.length > 0) {
        const agents = await AgentModel.findBasicByOrganizationIdAndIds({
          organizationId,
          agentIds: allAgentIds,
        });
        for (const agent of agents) {
          agentDetailsMap.set(agent.id, {
            id: agent.id,
            name: agent.name,
            agentType: agent.agentType,
          });
        }
      }

      const connectorsByKbId = new Map<
        string,
        { id: string; name: string; connectorType: ConnectorType }[]
      >();
      for (const connector of allConnectors) {
        const list = connectorsByKbId.get(connector.knowledgeBaseId) ?? [];
        list.push({
          id: connector.id,
          name: connector.name,
          connectorType: connector.connectorType,
        });
        connectorsByKbId.set(connector.knowledgeBaseId, list);
      }

      const data = knowledgeBases.map((kb) => ({
        ...kb,
        connectors: connectorsByKbId.get(kb.id) ?? [],
        totalDocsIndexed: docsIndexedByKbId.get(kb.id) ?? 0,
        assignedAgents: (agentIdsByKbId.get(kb.id) ?? [])
          .map((id) => agentDetailsMap.get(id))
          .filter(
            (a): a is { id: string; name: string; agentType: string } =>
              a !== undefined,
          ),
      }));

      return reply.send({
        data,
        pagination: calculatePaginationMeta(total, { limit, offset }),
      });
    },
  );

  fastify.post(
    "/api/knowledge-bases",
    {
      schema: {
        operationId: RouteId.CreateKnowledgeBase,
        description: "Create a new knowledge base",
        tags: ["Knowledge Bases"],
        body: z.object({
          name: z.string().min(1),
          description: z.string().optional(),
        }),
        response: constructResponseSchema(SelectKnowledgeBaseSchema),
      },
    },
    async ({ body, organizationId }, reply) => {
      const kg = await KnowledgeBaseModel.create({
        organizationId,
        name: body.name,
        ...(body.description !== undefined && {
          description: body.description,
        }),
      });

      return reply.send(kg);
    },
  );

  fastify.get(
    "/api/knowledge-bases/:id",
    {
      schema: {
        operationId: RouteId.GetKnowledgeBase,
        description: "Get a knowledge base by ID",
        tags: ["Knowledge Bases"],
        params: z.object({ id: z.uuid() }),
        response: constructResponseSchema(SelectKnowledgeBaseSchema),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      const kg = await findKnowledgeBaseOrThrow({
        id,
        organizationId,
        userId: user.id,
      });
      return reply.send(kg);
    },
  );

  fastify.put(
    "/api/knowledge-bases/:id",
    {
      schema: {
        operationId: RouteId.UpdateKnowledgeBase,
        description: "Update a knowledge base",
        tags: ["Knowledge Bases"],
        params: z.object({ id: z.uuid() }),
        body: z.object({
          name: z.string().min(1).optional(),
          description: z.string().nullable().optional(),
        }),
        response: constructResponseSchema(SelectKnowledgeBaseSchema),
      },
    },
    async ({ params: { id }, body, organizationId, user }, reply) => {
      await findKnowledgeBaseOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      const updated = await KnowledgeBaseModel.update(id, body);
      if (!updated) {
        throw new ApiError(404, "Knowledge base not found");
      }

      return reply.send(updated);
    },
  );

  fastify.delete(
    "/api/knowledge-bases/:id",
    {
      schema: {
        operationId: RouteId.DeleteKnowledgeBase,
        description:
          "Delete a knowledge base and remove its connector assignments",
        tags: ["Knowledge Bases"],
        params: z.object({ id: z.uuid() }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      await findKnowledgeBaseOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      const success = await KnowledgeBaseModel.delete(id);
      if (!success) {
        throw new ApiError(404, "Knowledge base not found");
      }

      return reply.send({ success: true });
    },
  );

  fastify.get(
    "/api/knowledge-bases/:id/health",
    {
      schema: {
        operationId: RouteId.GetKnowledgeBaseHealth,
        description: "Check the health of a knowledge base",
        tags: ["Knowledge Bases"],
        params: z.object({ id: z.uuid() }),
        response: constructResponseSchema(
          z.object({
            status: z.enum(["healthy", "unhealthy"]),
            message: z.string().optional(),
          }),
        ),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      await findKnowledgeBaseOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      // TODO: Replace with pgvector-based health check (verify vector extension,
      // check document/chunk counts, embedding processing status)
      return reply.send({
        status: "healthy" as const,
        message: "Knowledge base uses built-in pgvector RAG stack",
      });
    },
  );

  // ===== Standalone Connector Endpoints =====

  fastify.get(
    "/api/connectors",
    {
      schema: {
        operationId: RouteId.GetConnectors,
        description: "List all connectors for the organization",
        tags: ["Connectors"],
        querystring: PaginationQuerySchema.extend({
          knowledgeBaseId: z.string().optional(),
          search: z.string().optional(),
          connectorType: ConnectorTypeSchema.optional(),
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(
            SelectKnowledgeBaseConnectorSchema.extend({
              assignedAgents: z.array(AssignedAgentSummarySchema),
            }),
          ),
        ),
      },
    },
    async (
      {
        query: { limit, offset, knowledgeBaseId, search, connectorType },
        organizationId,
        user,
      },
      reply,
    ) => {
      const access =
        await knowledgeSourceAccessControlService.buildAccessControlContext({
          userId: user.id,
          organizationId,
        });
      let data: Awaited<
        ReturnType<typeof KnowledgeBaseConnectorModel.findByOrganization>
      >;
      let total: number;

      if (knowledgeBaseId) {
        await findKnowledgeBaseOrThrow({
          id: knowledgeBaseId,
          organizationId,
          userId: user.id,
        });
        data = await KnowledgeBaseConnectorModel.findByKnowledgeBaseId(
          knowledgeBaseId,
          {
            canReadAll: access.canReadAll,
            viewerTeamIds: access.teamIds,
          },
        );
        total = data.length;
      } else {
        const result =
          await KnowledgeBaseConnectorModel.findByOrganizationPaginated({
            organizationId,
            limit,
            offset,
            search,
            connectorType,
            canReadAll: access.canReadAll,
            viewerTeamIds: access.teamIds,
          });
        data = result.data;
        total = result.total;
      }

      // Enrich connectors with assigned agents (batch query to avoid N+1)
      const connectorIds = data.map((c) => c.id);
      const agentIdsByConnector =
        await AgentConnectorAssignmentModel.getAgentIdsForConnectors(
          connectorIds,
        );

      const allAgentIdsForConnectors = [
        ...new Set([...agentIdsByConnector.values()].flat()),
      ];
      const connectorAgentDetailsMap = new Map<
        string,
        { id: string; name: string; agentType: string }
      >();
      if (allAgentIdsForConnectors.length > 0) {
        const agents = await AgentModel.findBasicByOrganizationIdAndIds({
          organizationId,
          agentIds: allAgentIdsForConnectors,
        });
        for (const agent of agents) {
          connectorAgentDetailsMap.set(agent.id, {
            id: agent.id,
            name: agent.name,
            agentType: agent.agentType,
          });
        }
      }

      const enrichedData = data.map((connector) => ({
        ...connector,
        assignedAgents: (agentIdsByConnector.get(connector.id) ?? [])
          .map((id) => connectorAgentDetailsMap.get(id))
          .filter(
            (a): a is { id: string; name: string; agentType: string } =>
              a !== undefined,
          ),
      }));

      const validatedData = enrichedData.filter((connector) => {
        const parsed = SelectKnowledgeBaseConnectorSchema.safeParse(connector);
        if (parsed.success) return true;
        logger.warn(
          {
            connectorId: connector.id,
            connectorType: connector.connectorType,
            configType: (connector.config as Record<string, unknown> | null)
              ?.type,
            validationErrors: parsed.error.issues.map((i) => ({
              path: i.path.join("."),
              code: i.code,
              message: i.message,
            })),
          },
          "Skipping connector with invalid persisted schema",
        );
        return false;
      });

      const currentPage = Math.floor(offset / limit) + 1;
      const totalPages = Math.ceil(total / limit);

      return reply.send({
        data: validatedData,
        pagination: {
          currentPage,
          limit,
          total,
          totalPages,
          hasNext: currentPage < totalPages,
          hasPrev: currentPage > 1,
        },
      });
    },
  );

  fastify.post(
    "/api/connectors",
    {
      schema: {
        operationId: RouteId.CreateConnector,
        description: "Create a new connector",
        tags: ["Connectors"],
        body: z.object({
          name: z.string().min(1),
          description: z.string().nullable().optional(),
          visibility: KnowledgeSourceVisibilitySchema.optional(),
          teamIds: z.array(z.string()).optional(),
          connectorType: ConnectorTypeSchema,
          config: ConnectorConfigSchema,
          // optional: GitHub App connectors authenticate via a referenced
          // github_app_configs row instead of an inline secret
          credentials: ConnectorCredentialsSchema.optional(),
          schedule: z.string().optional(),
          enabled: z.boolean().optional(),
          knowledgeBaseIds: z.array(z.string()).optional(),
          environmentId: z.string().uuid().nullable().optional(),
        }),
        response: constructResponseSchema(SelectKnowledgeBaseConnectorSchema),
      },
    },
    async ({ body, organizationId, user }, reply) => {
      const teamIds = body.teamIds ?? [];
      const visibility = body.visibility ?? "org-wide";

      await assertEnvironmentAssignable({
        userId: user.id,
        organizationId,
        environmentId: body.environmentId ?? null,
      });

      if (isTeamScopedWithoutTeams({ visibility, teamIds })) {
        throw new ApiError(
          400,
          "At least one team must be selected for team-scoped connectors",
        );
      }
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      if (
        visibility === "team-scoped" &&
        !enterpriseTier.isKnowledgeBaseActive()
      ) {
        throw new ApiError(
          403,
          "Team-scoped connectors require an enterprise license",
        );
      }
      // SPDX-SnippetEnd

      // Validate connector config
      const connectorImpl = getConnector(body.connectorType);
      const validation = await connectorImpl.validateConfig(body.config);
      if (!validation.valid) {
        throw new ApiError(
          400,
          `Invalid connector configuration: ${validation.error}`,
        );
      }

      // Validate knowledge base IDs if provided
      if (body.knowledgeBaseIds && body.knowledgeBaseIds.length > 0) {
        for (const kbId of body.knowledgeBaseIds) {
          await findKnowledgeBaseOrThrow({
            id: kbId,
            organizationId,
            userId: user.id,
          });
        }
      }

      // GitHub App connectors reference a github_app_configs row for their
      // credentials; everything else stores an inline secret.
      const appConfigRef = await resolveGithubAppConfigReference({
        config: body.config,
        organizationId,
        userId: user.id,
      });
      const usesGithubAppConfig = appConfigRef !== null;
      const requiresCredentials = body.connectorType !== "web_crawler";
      if (appConfigRef && body.config.type === "github") {
        // the App config owns the host the installation token is minted against,
        // so it is the single source of truth for the connector's API host
        body.config.githubUrl = appConfigRef.githubUrl;
      }

      let secretId: string | null = null;
      if (usesGithubAppConfig || !requiresCredentials) {
        if (body.credentials) {
          throw new ApiError(
            400,
            usesGithubAppConfig
              ? "GitHub App connectors must not include inline credentials"
              : "Web Crawler connectors must not include inline credentials",
          );
        }
      } else {
        if (!body.credentials) {
          throw new ApiError(
            400,
            "Credentials are required for this connector",
          );
        }
        const secret = await secretManager().createSecret(
          body.credentials,
          `connector-${body.name}`,
        );
        secretId = secret.id;
      }

      // Create the connector
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: body.name,
        description: body.description ?? null,
        visibility: body.visibility,
        teamIds: body.teamIds,
        connectorType: body.connectorType,
        config: body.config,
        secretId,
        environmentId: body.environmentId ?? null,
        schedule: body.schedule,
        enabled: body.enabled,
      });

      // Assign to knowledge bases if provided
      if (body.knowledgeBaseIds && body.knowledgeBaseIds.length > 0) {
        for (const kbId of body.knowledgeBaseIds) {
          await KnowledgeBaseConnectorModel.assignToKnowledgeBase(
            connector.id,
            kbId,
          );
        }
      }

      // Auto-trigger initial sync
      await taskQueueService.enqueue({
        taskType: "connector_sync",
        payload: { connectorId: connector.id },
      });
      const updatedConnector = await KnowledgeBaseConnectorModel.update(
        connector.id,
        { lastSyncStatus: "running" },
      );

      return reply.send(updatedConnector ?? connector);
    },
  );

  fastify.get(
    "/api/connectors/:id",
    {
      schema: {
        operationId: RouteId.GetConnector,
        description: "Get a connector by ID",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid() }),
        response: constructResponseSchema(
          SelectKnowledgeBaseConnectorSchema.extend({
            totalDocsIngested: z.number(),
          }),
        ),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      const connector = await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });
      const totalDocsIngested = await KbDocumentModel.countByConnector(id);
      return reply.send({ ...connector, totalDocsIngested });
    },
  );

  fastify.get(
    "/api/connectors/:id/documents",
    {
      schema: {
        operationId: RouteId.GetConnectorDocuments,
        description: "List documents for a connector",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid() }),
        querystring: PaginationQuerySchema.extend({
          search: z.string().optional(),
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(KnowledgeBaseDocumentListItemSchema),
        ),
      },
    },
    async (
      {
        params: { id },
        query: { limit, offset, search },
        organizationId,
        user,
      },
      reply,
    ) => {
      await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      const [data, total] = await Promise.all([
        KbDocumentModel.findListItemsByConnector({
          connectorId: id,
          organizationId,
          limit,
          offset,
          search,
        }),
        KbDocumentModel.countByConnectorWithSearch({
          connectorId: id,
          organizationId,
          search,
        }),
      ]);

      return reply.send({
        data,
        pagination: calculatePaginationMeta(total, { limit, offset }),
      });
    },
  );

  fastify.get(
    "/api/connectors/:id/documents/:docId",
    {
      schema: {
        operationId: RouteId.GetConnectorDocument,
        description: "Get a single connector document",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid(), docId: z.uuid() }),
        response: constructResponseSchema(KnowledgeBaseDocumentDetailSchema),
      },
    },
    async ({ params: { id, docId }, organizationId, user }, reply) => {
      await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      const existing = await KbDocumentModel.findListItemByIdAndConnector({
        documentId: docId,
        connectorId: id,
        organizationId,
      });
      if (!existing) {
        throw new ApiError(404, "Document not found");
      }

      return reply.send(existing);
    },
  );

  fastify.delete(
    "/api/connectors/:id/documents/:docId",
    {
      schema: {
        operationId: RouteId.DeleteConnectorDocument,
        description: "Delete a connector document",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid(), docId: z.uuid() }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id, docId }, organizationId, user }, reply) => {
      await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      const existing = await KbDocumentModel.findListItemByIdAndConnector({
        documentId: docId,
        connectorId: id,
        organizationId,
      });
      if (!existing) {
        throw new ApiError(404, "Document not found");
      }

      await KbDocumentModel.delete(docId);
      return reply.send({ success: true });
    },
  );

  fastify.put(
    "/api/connectors/:id",
    {
      schema: {
        operationId: RouteId.UpdateConnector,
        description: "Update a connector",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid() }),
        body: z.object({
          name: z.string().min(1).optional(),
          description: z.string().nullable().optional(),
          visibility: KnowledgeSourceVisibilitySchema.optional(),
          teamIds: z.array(z.string()).optional(),
          config: ConnectorConfigSchema.optional(),
          credentials: ConnectorCredentialsSchema.optional(),
          schedule: z.string().optional(),
          enabled: z.boolean().optional(),
          environmentId: z.string().uuid().nullable().optional(),
        }),
        response: constructResponseSchema(SelectKnowledgeBaseConnectorSchema),
      },
    },
    async ({ params: { id }, body, organizationId, user }, reply) => {
      const connector = await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      if (body.environmentId !== undefined) {
        await assertEnvironmentAssignable({
          userId: user.id,
          organizationId,
          environmentId: body.environmentId,
        });
      }

      // resolve the connector's auth shape after this update so credential
      // storage stays consistent across App <-> inline-secret transitions
      const nextConfig = body.config ?? connector.config;
      const appConfigRef = await resolveGithubAppConfigReference({
        config: nextConfig,
        organizationId,
        userId: user.id,
      });
      const usesGithubAppConfig = appConfigRef !== null;
      const requiresCredentials = connector.connectorType !== "web_crawler";
      if (appConfigRef && body.config?.type === "github") {
        // the App config owns the host the installation token is minted against
        body.config.githubUrl = appConfigRef.githubUrl;
      }

      const { credentials: _, ...updateData } = body;
      const nextVisibility = updateData.visibility ?? connector.visibility;
      const nextTeamIds = updateData.teamIds ?? connector.teamIds;

      // validate everything that can reject the request BEFORE touching any
      // secret, so a rejected update never leaves the connector with a
      // deleted or replaced credential
      if (
        isTeamScopedWithoutTeams({
          visibility: nextVisibility,
          teamIds: nextTeamIds,
        })
      ) {
        throw new ApiError(
          400,
          "At least one team must be selected for team-scoped connectors",
        );
      }
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      if (
        connector.visibility !== "team-scoped" &&
        nextVisibility === "team-scoped" &&
        !enterpriseTier.isKnowledgeBaseActive()
      ) {
        throw new ApiError(
          403,
          "Team-scoped connectors require an enterprise license",
        );
      }
      // SPDX-SnippetEnd
      if (usesGithubAppConfig && body.credentials) {
        throw new ApiError(
          400,
          "GitHub App connectors must not include inline credentials",
        );
      }
      if (!requiresCredentials && body.credentials) {
        throw new ApiError(
          400,
          "Web Crawler connectors must not include inline credentials",
        );
      }
      const wasGithubApp =
        connector.config.type === "github" &&
        connector.config.authMethod === "github_app";
      if (
        wasGithubApp &&
        !usesGithubAppConfig &&
        !body.credentials &&
        !connector.secretId
      ) {
        // leaving App auth means the connector has no inline secret yet, so a
        // new credential must be supplied with the switch
        throw new ApiError(
          400,
          "Credentials are required when switching this connector to token authentication",
        );
      }

      let nextSecretId = connector.secretId;
      let secretToDeleteAfterUpdate: string | null = null;
      if (usesGithubAppConfig || !requiresCredentials) {
        // defer dropping the connector's own inline secret until the update has
        // been persisted, so a later failure can't orphan the connector
        if (connector.secretId) {
          secretToDeleteAfterUpdate = connector.secretId;
          nextSecretId = null;
        }
      } else if (body.credentials) {
        if (connector.secretId) {
          // The edit dialog promises "leave empty to keep existing
          // credentials" and omits the email/username field when blank, but
          // updateSecret replaces the whole value — preserve the stored email
          // so rotating only the token doesn't drop the username.
          let credentials = body.credentials;
          if (!credentials.email) {
            const existing = await secretManager().getSecret(
              connector.secretId,
            );
            const storedEmail = (
              existing?.secret as Record<string, unknown> | undefined
            )?.email;
            if (typeof storedEmail === "string" && storedEmail) {
              credentials = { ...credentials, email: storedEmail };
            }
          }
          await secretManager().updateSecret(connector.secretId, credentials);
        } else {
          const secret = await secretManager().createSecret(
            body.credentials,
            `connector-${body.name ?? connector.name}`,
          );
          nextSecretId = secret.id;
        }
      }

      // Reset checkpoint when config changes to force a full re-sync
      // (filters, queries, inclusion/exclusion criteria affect which items get synced)
      const updated = await KnowledgeBaseConnectorModel.update(id, {
        ...updateData,
        secretId: nextSecretId,
        ...(updateData.config ? { checkpoint: null } : {}),
      });
      if (!updated) {
        throw new ApiError(404, "Connector not found");
      }

      if (secretToDeleteAfterUpdate) {
        await secretManager().deleteSecret(secretToDeleteAfterUpdate);
      }

      if (
        didKnowledgeSourceAclInputsChange({
          current: connector,
          updates: {
            visibility: updateData.visibility,
            teamIds: updateData.teamIds,
          },
        })
      ) {
        // This rewrites ACLs across every document and chunk for the connector,
        // so only run it when the connector's actual ACL inputs changed.
        await knowledgeSourceAccessControlService.refreshConnectorDocumentAccessControlLists(
          id,
        );
      }

      return reply.send(updated);
    },
  );

  fastify.delete(
    "/api/connectors/:id",
    {
      schema: {
        operationId: RouteId.DeleteConnector,
        description: "Delete a connector",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid() }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      const connector = await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      // Delete the secret
      if (connector.secretId) {
        try {
          await secretManager().deleteSecret(connector.secretId);
        } catch (error) {
          logger.warn(
            {
              secretId: connector.secretId,
              error: error instanceof Error ? error.message : String(error),
            },
            "[Connector] Failed to delete connector secret",
          );
        }
      }

      const success = await KnowledgeBaseConnectorModel.delete(id);
      if (!success) {
        throw new ApiError(404, "Connector not found");
      }

      return reply.send({ success: true });
    },
  );

  fastify.post(
    "/api/connectors/:id/sync",
    {
      schema: {
        operationId: RouteId.SyncConnector,
        description: "Manually trigger a connector sync",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid() }),
        response: constructResponseSchema(
          z.object({
            taskId: z.string(),
            status: z.string(),
          }),
        ),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      const hasPendingOrProcessing = await TaskModel.hasPendingOrProcessing(
        "connector_sync",
        id,
      );
      if (hasPendingOrProcessing) {
        throw new ApiError(
          409,
          "A sync is already in progress for this connector",
        );
      }

      const taskId = await taskQueueService.enqueue({
        taskType: "connector_sync",
        payload: { connectorId: id },
      });

      // Set status immediately so the UI can react before the worker picks up the task
      await KnowledgeBaseConnectorModel.update(id, {
        lastSyncStatus: "running",
      });

      return reply.send({ taskId, status: "enqueued" });
    },
  );

  fastify.post(
    "/api/connectors/:id/force-resync",
    {
      schema: {
        operationId: RouteId.ForceResyncConnector,
        description:
          "Force a full re-sync: deletes all documents, chunks, run history, and resets the checkpoint",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid() }),
        response: constructResponseSchema(
          z.object({
            taskId: z.string(),
            status: z.string(),
          }),
        ),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      const hasPendingOrProcessing = await TaskModel.hasPendingOrProcessing(
        "connector_sync",
        id,
      );
      if (hasPendingOrProcessing) {
        throw new ApiError(
          409,
          "A sync is already in progress for this connector",
        );
      }

      // Delete all documents (chunks cascade via FK) and run history
      await KbDocumentModel.deleteByConnector(id);
      await ConnectorRunModel.deleteByConnector(id);

      // Reset connector checkpoint and sync status
      await KnowledgeBaseConnectorModel.update(id, {
        checkpoint: null,
        lastSyncStatus: "running",
        lastSyncAt: null,
      });

      // Enqueue a fresh sync task
      const taskId = await taskQueueService.enqueue({
        taskType: "connector_sync",
        payload: { connectorId: id },
      });

      return reply.send({ taskId, status: "enqueued" });
    },
  );

  fastify.post(
    "/api/connectors/:id/test",
    {
      schema: {
        operationId: RouteId.TestConnectorConnection,
        description: "Test a connector connection",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid() }),
        response: constructResponseSchema(
          z.object({
            success: z.boolean(),
            error: z.string().optional(),
          }),
        ),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      const connector = await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      // Load credentials (resolves github_app_configs references when needed)
      const credentials = await resolveConnectorCredentials(connector);

      // Get the connector implementation and test
      const connectorImpl = getConnector(connector.connectorType);
      const result = await connectorImpl.testConnection({
        config: connector.config as Record<string, unknown>,
        credentials,
      });

      return reply.send(result);
    },
  );

  // ===== Connector Knowledge Base Assignments =====

  fastify.post(
    "/api/connectors/:id/knowledge-bases",
    {
      schema: {
        operationId: RouteId.AssignConnectorToKnowledgeBases,
        description: "Assign a connector to one or more knowledge bases",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid() }),
        body: z.object({
          knowledgeBaseIds: z.array(z.string()).min(1),
        }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params: { id }, body, organizationId, user }, reply) => {
      await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      for (const kbId of body.knowledgeBaseIds) {
        await findKnowledgeBaseOrThrow({
          id: kbId,
          organizationId,
          userId: user.id,
        });
        await KnowledgeBaseConnectorModel.assignToKnowledgeBase(id, kbId);
      }

      return reply.send({ success: true });
    },
  );

  fastify.delete(
    "/api/connectors/:id/knowledge-bases/:kbId",
    {
      schema: {
        operationId: RouteId.UnassignConnectorFromKnowledgeBase,
        description: "Unassign a connector from a knowledge base",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid(), kbId: z.uuid() }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id, kbId }, organizationId, user }, reply) => {
      await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });
      await findKnowledgeBaseOrThrow({
        id: kbId,
        organizationId,
        userId: user.id,
      });

      const success =
        await KnowledgeBaseConnectorModel.unassignFromKnowledgeBase(id, kbId);
      if (!success) {
        throw new ApiError(404, "Assignment not found");
      }

      return reply.send({ success: true });
    },
  );

  fastify.get(
    "/api/connectors/:id/knowledge-bases",
    {
      schema: {
        operationId: RouteId.GetConnectorKnowledgeBases,
        description: "List knowledge bases assigned to a connector",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid() }),
        response: constructResponseSchema(
          z.object({
            data: z.array(SelectKnowledgeBaseSchema),
          }),
        ),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      const access =
        await knowledgeSourceAccessControlService.buildAccessControlContext({
          userId: user.id,
          organizationId,
        });
      await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      const kbIds = await KnowledgeBaseConnectorModel.getKnowledgeBaseIds(id);
      const knowledgeBases: z.infer<typeof SelectKnowledgeBaseSchema>[] = [];

      for (const kbId of kbIds) {
        const kb = await KnowledgeBaseModel.findById(kbId);
        if (
          kb &&
          kb.organizationId === organizationId &&
          knowledgeSourceAccessControlService.canAccessKnowledgeBase(access, kb)
        ) {
          knowledgeBases.push(kb);
        }
      }

      return reply.send({ data: knowledgeBases });
    },
  );

  // ===== Connector Runs =====

  fastify.get(
    "/api/connectors/:id/runs",
    {
      schema: {
        operationId: RouteId.GetConnectorRuns,
        description: "List connector runs",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid() }),
        querystring: PaginationQuerySchema,
        response: constructResponseSchema(
          createPaginatedResponseSchema(SelectConnectorRunListSchema),
        ),
      },
    },
    async (
      { params: { id }, query: { limit, offset }, organizationId, user },
      reply,
    ) => {
      await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      const [data, total] = await Promise.all([
        ConnectorRunModel.findByConnectorList({
          connectorId: id,
          limit,
          offset,
        }),
        ConnectorRunModel.countByConnector(id),
      ]);

      const currentPage = Math.floor(offset / limit) + 1;
      const totalPages = Math.ceil(total / limit);

      return reply.send({
        data,
        pagination: {
          currentPage,
          limit,
          total,
          totalPages,
          hasNext: currentPage < totalPages,
          hasPrev: currentPage > 1,
        },
      });
    },
  );

  fastify.get(
    "/api/connectors/:id/runs/:runId",
    {
      schema: {
        operationId: RouteId.GetConnectorRun,
        description: "Get a single connector run (including logs)",
        tags: ["Connectors"],
        params: z.object({
          id: z.uuid(),
          runId: z.uuid(),
        }),
        response: constructResponseSchema(SelectConnectorRunDetailSchema),
      },
    },
    async ({ params: { id, runId }, organizationId, user }, reply) => {
      await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      const run = await ConnectorRunModel.findById(runId);
      if (!run || run.connectorId !== id) {
        throw new ApiError(404, "Connector run not found");
      }

      return reply.send(run);
    },
  );
};

export default knowledgeBaseRoutes;

// ===== Internal Helpers =====

/**
 * Gate assigning a knowledge base / connector to an environment. Mirrors the
 * agent + MCP-catalog write paths: a restricted environment (or a restricted
 * org default when environmentId is null/omitted) requires
 * environment:deploy-to-restricted (environment:admin implies it). Also
 * validates the environment belongs to the org, preventing cross-tenant binding.
 */
async function assertEnvironmentAssignable(params: {
  userId: string;
  organizationId: string;
  environmentId: string | null;
}): Promise<void> {
  const { userId, organizationId, environmentId } = params;
  const [hasEnvAdmin, hasEnvDeploy] = await Promise.all([
    userHasPermission(userId, organizationId, "environment", "admin"),
    userHasPermission(
      userId,
      organizationId,
      "environment",
      "deploy-to-restricted",
    ),
  ]);
  await assertCanAssignEnvironment({
    environmentId,
    organizationId,
    canDeployToRestricted: hasEnvAdmin || hasEnvDeploy,
  });
}

async function findKnowledgeBaseOrThrow(params: {
  id: string;
  organizationId: string;
  userId: string;
}) {
  const kg = await KnowledgeBaseModel.findById(params.id);
  if (!kg || kg.organizationId !== params.organizationId) {
    throw new ApiError(404, "Knowledge base not found");
  }
  return kg;
}

async function findConnectorOrThrow(params: {
  id: string;
  organizationId: string;
  userId: string;
}) {
  const connector = await KnowledgeBaseConnectorModel.findById(params.id);
  if (!connector || connector.organizationId !== params.organizationId) {
    throw new ApiError(404, "Connector not found");
  }
  const access =
    await knowledgeSourceAccessControlService.buildAccessControlContext({
      userId: params.userId,
      organizationId: params.organizationId,
    });
  if (
    !knowledgeSourceAccessControlService.canAccessConnector(access, connector)
  ) {
    throw new ApiError(404, "Connector not found");
  }
  return connector;
}

/**
 * Validate a connector's GitHub App reference. Returns the referenced
 * github_app_configs id when the connector uses GitHub App auth (after
 * confirming it belongs to the organization), or null otherwise.
 */
async function resolveGithubAppConfigReference(params: {
  config: ConnectorConfig;
  organizationId: string;
  userId: string;
}): Promise<{ id: string; githubUrl: string } | null> {
  const { config, organizationId, userId } = params;
  if (config.type !== "github" || config.authMethod !== "github_app") {
    return null;
  }
  if (!config.githubAppConfigId) {
    throw new ApiError(
      400,
      "GitHub App authentication requires githubAppConfigId",
    );
  }
  // referencing a stored App credential lets the connector mint installation
  // tokens, so it requires the dedicated githubAppConfig:read permission on top
  // of the connector permission the route already enforces
  const canUseAppConfig = await userHasPermission(
    userId,
    organizationId,
    "githubAppConfig",
    "read",
  );
  if (!canUseAppConfig) {
    throw new ApiError(
      403,
      "You do not have permission to use GitHub App configurations",
    );
  }
  const appConfig = await GithubAppConfigModel.findByIdForOrganization({
    id: config.githubAppConfigId,
    organizationId,
  });
  if (!appConfig) {
    throw new ApiError(
      400,
      "Referenced GitHub App configuration was not found",
    );
  }
  return { id: appConfig.id, githubUrl: appConfig.githubUrl };
}
