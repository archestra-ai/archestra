import {
  calculatePaginationMeta,
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import {
  didKnowledgeSourceAclInputsChange,
  isTeamScopedWithoutTeams,
  knowledgeSourceAccessControlService,
} from "@/knowledge-base";
import {
  isSupportedMimeType,
  MAX_FILE_SIZE_BYTES,
  MAX_ZIP_TOTAL_BYTES,
} from "@/knowledge-base/connectors/file-upload/file-processor";
import { getConnector } from "@/knowledge-base/connectors/registry";
import logger from "@/logging";
import {
  AgentConnectorAssignmentModel,
  AgentKnowledgeBaseModel,
  AgentModel,
  ConnectorRunModel,
  KbDocumentModel,
  KbUploadedFileModel,
  KnowledgeBaseConnectorModel,
  KnowledgeBaseModel,
  TaskModel,
} from "@/models";
import { secretManager } from "@/secrets-manager";
import { taskQueueService } from "@/task-queue";
import {
  ApiError,
  ConnectorConfigSchema,
  type ConnectorCredentials,
  ConnectorCredentialsSchema,
  type ConnectorType,
  ConnectorTypeSchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  EmbeddingStatusSchema,
  KnowledgeSourceVisibilitySchema,
  SelectConnectorRunListSchema,
  SelectConnectorRunSchema,
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
        const agents = await AgentModel.findByOrganizationId(organizationId);
        for (const agent of agents) {
          if (allAgentIds.includes(agent.id)) {
            agentDetailsMap.set(agent.id, {
              id: agent.id,
              name: agent.name,
              agentType: agent.agentType,
            });
          }
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
        params: z.object({ id: z.string() }),
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
        params: z.object({ id: z.string() }),
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
        params: z.object({ id: z.string() }),
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
        params: z.object({ id: z.string() }),
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

      const currentPage = Math.floor(offset / limit) + 1;
      const totalPages = Math.ceil(total / limit);

      return reply.send({
        data: enrichedData,
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
          credentials: ConnectorCredentialsSchema,
          schedule: z.string().optional(),
          enabled: z.boolean().optional(),
          knowledgeBaseIds: z.array(z.string()).optional(),
        }),
        response: constructResponseSchema(SelectKnowledgeBaseConnectorSchema),
      },
    },
    async ({ body, organizationId, user }, reply) => {
      const teamIds = body.teamIds ?? [];
      const visibility = body.visibility ?? "org-wide";
      if (isTeamScopedWithoutTeams({ visibility, teamIds })) {
        throw new ApiError(
          400,
          "At least one team must be selected for team-scoped connectors",
        );
      }

      if (
        visibility === "team-scoped" &&
        !config.enterpriseFeatures.knowledgeBase
      ) {
        throw new ApiError(
          403,
          "Team-scoped connectors require an enterprise license. Please contact sales@archestra.ai to enable it.",
        );
      }

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

      // Store credentials as a secret
      const secret = await secretManager().createSecret(
        body.credentials,
        `connector-${body.name}`,
      );

      // Create the connector
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: body.name,
        description: body.description ?? null,
        visibility: body.visibility,
        teamIds: body.teamIds,
        connectorType: body.connectorType,
        config: body.config,
        secretId: secret.id,
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
        params: z.object({ id: z.string() }),
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

  fastify.put(
    "/api/connectors/:id",
    {
      schema: {
        operationId: RouteId.UpdateConnector,
        description: "Update a connector",
        tags: ["Connectors"],
        params: z.object({ id: z.string() }),
        body: z.object({
          name: z.string().min(1).optional(),
          description: z.string().nullable().optional(),
          visibility: KnowledgeSourceVisibilitySchema.optional(),
          teamIds: z.array(z.string()).optional(),
          config: ConnectorConfigSchema.optional(),
          credentials: ConnectorCredentialsSchema.optional(),
          schedule: z.string().optional(),
          enabled: z.boolean().optional(),
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

      // Update credentials secret if provided
      if (body.credentials && connector.secretId) {
        await secretManager().updateSecret(
          connector.secretId,
          body.credentials,
        );
      }

      const { credentials: _, ...updateData } = body;
      const nextVisibility = updateData.visibility ?? connector.visibility;
      const nextTeamIds = updateData.teamIds ?? connector.teamIds;
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

      if (
        nextVisibility === "team-scoped" &&
        connector.visibility !== "team-scoped" &&
        !config.enterpriseFeatures.knowledgeBase
      ) {
        throw new ApiError(
          403,
          "Team-scoped connectors require an enterprise license. Please contact sales@archestra.ai to enable it.",
        );
      }

      // Reset checkpoint when config changes to force a full re-sync
      // (filters, queries, inclusion/exclusion criteria affect which items get synced)
      const updated = await KnowledgeBaseConnectorModel.update(id, {
        ...updateData,
        ...(updateData.config ? { checkpoint: null } : {}),
      });
      if (!updated) {
        throw new ApiError(404, "Connector not found");
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
        params: z.object({ id: z.string() }),
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
        params: z.object({ id: z.string() }),
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
        params: z.object({ id: z.string() }),
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
        params: z.object({ id: z.string() }),
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

      // Load credentials
      const credentials = await loadConnectorCredentials(connector.secretId);

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
        params: z.object({ id: z.string() }),
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
        params: z.object({ id: z.string(), kbId: z.string() }),
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
        params: z.object({ id: z.string() }),
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
        params: z.object({ id: z.string() }),
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
          id: z.string(),
          runId: z.string(),
        }),
        response: constructResponseSchema(SelectConnectorRunSchema),
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

  // ===== File Upload Routes =====

  const UploadResultSchema = z.object({
    filename: z.string(),
    status: z.enum([
      "created",
      "duplicate",
      "unsupported",
      "too_large",
      "extraction_failed",
    ]),
    fileId: z.string().optional(),
  });

  const UploadedFileSchema = z.object({
    id: z.string(),
    connectorId: z.string(),
    originalName: z.string().min(1),
    mimeType: z.string(),
    fileSize: z.number().int().nonnegative(),
    contentHash: z.string(),
    createdAt: z.string(),
    processingStatus: z.string(),
    processingError: z.string().nullable(),
    embeddingStatus: EmbeddingStatusSchema,
  });

  fastify.post(
    "/api/connectors/:id/files",
    {
      bodyLimit: config.api.bodyLimit,
      schema: {
        operationId: RouteId.UploadConnectorFiles,
        description:
          "Upload files to a file-upload connector. " +
          "Send files as base64-encoded content in a JSON array.",
        tags: ["Connectors"],
        params: z.object({ id: z.string() }),
        body: z.object({
          files: z.array(
            z.object({
              name: z.string(),
              mimeType: z.string(),
              content: z.string(), // base64-encoded file bytes
            }),
          ),
        }),
        response: constructResponseSchema(
          z.object({ results: z.array(UploadResultSchema) }),
        ),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { organizationId, user } = request;

      const connector = await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      if (connector.connectorType !== "file_upload") {
        throw new ApiError(
          400,
          "This endpoint is only available for file_upload connectors",
        );
      }

      const results: z.infer<typeof UploadResultSchema>[] = [];
      const createdFileIds: string[] = [];

      for (const file of request.body.files) {
        const filename = file.name;
        const mimeType = file.mimeType;

        if (!isSupportedMimeType(filename, mimeType)) {
          results.push({ filename, status: "unsupported" });
          continue;
        }

        const rawBuffer = Buffer.from(file.content, "base64");

        const isZip =
          filename.toLowerCase().endsWith(".zip") ||
          mimeType === "application/zip" ||
          mimeType === "application/x-zip-compressed";
        const uploadSizeLimit = isZip
          ? MAX_ZIP_TOTAL_BYTES
          : MAX_FILE_SIZE_BYTES;

        if (rawBuffer.byteLength > uploadSizeLimit) {
          results.push({ filename, status: "too_large" });
          continue;
        }

        if (isZip) {
          const JSZip = (await import("jszip")).default;
          const zip = await JSZip.loadAsync(rawBuffer);
          let totalBytes = 0;

          for (const [relativePath, entry] of Object.entries(zip.files)) {
            if (entry.dir) continue;
            const basename = relativePath.split("/").pop() ?? relativePath;
            if (basename.startsWith(".")) continue;
            if (relativePath.startsWith("__MACOSX/")) continue;

            if (!isSupportedMimeType(basename, "")) {
              results.push({ filename: relativePath, status: "unsupported" });
              continue;
            }

            const entryBytes = await entry.async("nodebuffer");
            if (entryBytes.byteLength > MAX_FILE_SIZE_BYTES) {
              results.push({ filename: relativePath, status: "too_large" });
              continue;
            }
            totalBytes += entryBytes.byteLength;
            if (totalBytes > MAX_ZIP_TOTAL_BYTES) {
              results.push({ filename: relativePath, status: "too_large" });
              break;
            }

            const contentHash = KbUploadedFileModel.computeContentHash(
              entryBytes.toString("base64"),
            );

            const existing = await KbUploadedFileModel.findByContentHash(
              id,
              contentHash,
            );
            if (existing) {
              results.push({
                filename: relativePath,
                status: "duplicate",
              });
              continue;
            }

            try {
              const created = await KbUploadedFileModel.create({
                connectorId: id,
                organizationId,
                originalName: relativePath,
                mimeType: "",
                fileSize: entryBytes.byteLength,
                contentHash,
                fileData: entryBytes,
                processingStatus: "pending",
              });
              createdFileIds.push(created.id);
              results.push({
                filename: relativePath,
                status: "created",
                fileId: created.id,
              });
            } catch (err) {
              if (isContentHashConflict(err)) {
                results.push({
                  filename: relativePath,
                  status: "duplicate",
                });
                continue;
              }
              throw err;
            }
          }
        } else {
          const contentHash = KbUploadedFileModel.computeContentHash(
            rawBuffer.toString("base64"),
          );

          const existing = await KbUploadedFileModel.findByContentHash(
            id,
            contentHash,
          );
          if (existing) {
            results.push({
              filename,
              status: "duplicate",
            });
            continue;
          }

          try {
            const created = await KbUploadedFileModel.create({
              connectorId: id,
              organizationId,
              originalName: filename,
              mimeType,
              fileSize: rawBuffer.byteLength,
              contentHash,
              fileData: rawBuffer,
              processingStatus: "pending",
            });
            createdFileIds.push(created.id);
            results.push({
              filename,
              status: "created",
              fileId: created.id,
            });
          } catch (err) {
            if (isContentHashConflict(err)) {
              results.push({ filename, status: "duplicate" });
              continue;
            }
            throw err;
          }
        }
      }

      if (createdFileIds.length > 0) {
        await taskQueueService.enqueue({
          taskType: "process_uploaded_files",
          payload: {
            connectorId: id,
            fileIds: createdFileIds,
          },
        });
      }

      return reply.send({ results });
    },
  );

  fastify.get(
    "/api/connectors/:id/files",
    {
      schema: {
        operationId: RouteId.GetConnectorFiles,
        description: "List files uploaded to a file-upload connector",
        tags: ["Connectors"],
        params: z.object({ id: z.string() }),
        querystring: PaginationQuerySchema.extend({
          search: z.string().optional(),
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(UploadedFileSchema),
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
      await findConnectorOrThrow({ id, organizationId, userId: user.id });

      const [uploadedFiles, total] = await Promise.all([
        KbUploadedFileModel.findByConnectorPaginated({
          connectorId: id,
          limit,
          offset,
          search,
        }),
        KbUploadedFileModel.countByConnector({
          connectorId: id,
          search,
        }),
      ]);

      const docs = await KbDocumentModel.findBySourceIds({
        connectorId: id,
        sourceIds: uploadedFiles.map((f) => f.id),
      });
      const docBySourceId = new Map(docs.map((d) => [d.sourceId, d]));

      const data = uploadedFiles.map((file) => {
        const doc = docBySourceId.get(file.id);
        return {
          id: file.id,
          connectorId: file.connectorId,
          originalName: file.originalName,
          mimeType: file.mimeType,
          fileSize: file.fileSize,
          contentHash: file.contentHash,
          createdAt: file.createdAt.toISOString(),
          processingStatus: file.processingStatus,
          processingError: file.processingError ?? null,
          embeddingStatus: doc?.embeddingStatus ?? "pending",
        };
      });

      return reply.send({
        data,
        pagination: calculatePaginationMeta(total, { limit, offset }),
      });
    },
  );

  fastify.get(
    "/api/connectors/:id/files/:fileId",
    {
      schema: {
        operationId: RouteId.GetConnectorFile,
        description: "Get a single uploaded file by ID",
        tags: ["Connectors"],
        params: z.object({ id: z.string(), fileId: z.string() }),
        response: constructResponseSchema(UploadedFileSchema),
      },
    },
    async ({ params: { id, fileId }, organizationId, user }, reply) => {
      await findConnectorOrThrow({ id, organizationId, userId: user.id });

      const file = await KbUploadedFileModel.findById(fileId);
      if (!file || file.connectorId !== id) {
        throw new ApiError(404, "File not found");
      }

      const doc = await KbDocumentModel.findBySourceId({
        connectorId: id,
        sourceId: fileId,
      });

      return reply.send({
        id: file.id,
        connectorId: file.connectorId,
        originalName: file.originalName,
        mimeType: file.mimeType,
        fileSize: file.fileSize,
        contentHash: file.contentHash,
        createdAt: file.createdAt.toISOString(),
        processingStatus: file.processingStatus,
        processingError: file.processingError ?? null,
        embeddingStatus: doc?.embeddingStatus ?? "pending",
      });
    },
  );

  fastify.delete(
    "/api/connectors/:id/files/:fileId",
    {
      schema: {
        operationId: RouteId.DeleteConnectorFile,
        description: "Delete an uploaded file and its indexed content",
        tags: ["Connectors"],
        params: z.object({ id: z.string(), fileId: z.string() }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id, fileId }, organizationId, user }, reply) => {
      await findConnectorOrThrow({ id, organizationId, userId: user.id });

      const file = await KbUploadedFileModel.findById(fileId);
      if (!file || file.connectorId !== id) {
        throw new ApiError(404, "File not found");
      }

      await KbDocumentModel.deleteByConnectorAndSourceId({
        connectorId: id,
        sourceId: fileId,
      });

      await KbUploadedFileModel.delete(fileId);

      return reply.send({ success: true });
    },
  );
};

export default knowledgeBaseRoutes;

// ===== Internal Helpers =====

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

function isContentHashConflict(error: unknown): boolean {
  let current: unknown = error;
  while (typeof current === "object" && current !== null) {
    const msg = (current as Record<string, unknown>).message;
    if (
      typeof msg === "string" &&
      msg.includes("kb_uploaded_files_content_hash_uidx")
    ) {
      return true;
    }
    current = (current as Record<string, unknown>).cause;
  }
  return false;
}

async function loadConnectorCredentials(
  secretId: string | null,
): Promise<ConnectorCredentials> {
  if (!secretId) {
    throw new ApiError(400, "Connector has no associated credentials");
  }

  const secret = await secretManager().getSecret(secretId);
  if (!secret) {
    throw new ApiError(404, "Connector credentials not found");
  }

  const data = secret.secret as Record<string, unknown>;
  return {
    email: (data.email as string) || "",
    apiToken: (data.apiToken as string) || "",
  };
}
