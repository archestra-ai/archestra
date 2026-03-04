import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { cronJobManager } from "@/k8s/cron-job";
import { createKnowledgeBaseProvider } from "@/knowledge-base";
import { connectorSyncService } from "@/knowledge-base/connector-sync";
import { getConnector } from "@/knowledge-base/connectors/registry";
import logger from "@/logging";
import {
  ConnectorRunModel,
  KnowledgeBaseConnectorModel,
  KnowledgeBaseModel,
} from "@/models";
import { secretManager } from "@/secrets-manager";
import {
  ApiError,
  constructResponseSchema,
  createPaginatedResponseSchema,
  DeleteObjectResponseSchema,
  PaginationQuerySchema,
  SelectConnectorRunSchema,
  SelectKnowledgeBaseConnectorSchema,
  SelectKnowledgeBaseSchema,
} from "@/types";
import {
  KnowledgeBaseProviderTypeSchema,
  KnowledgeBaseVisibilitySchema,
  LightragConfigSchema,
} from "@/types/knowledge-base";
import {
  ConnectorConfigSchema,
  type ConnectorCredentials,
  ConnectorCredentialsSchema,
  ConnectorTypeSchema,
} from "@/types/knowledge-connector";

const KnowledgeBaseWithConnectorsSchema = SelectKnowledgeBaseSchema.extend({
  connectors: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      connectorType: ConnectorTypeSchema,
    }),
  ),
  totalDocsIndexed: z.number(),
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
        querystring: PaginationQuerySchema,
        response: constructResponseSchema(
          createPaginatedResponseSchema(KnowledgeBaseWithConnectorsSchema),
        ),
      },
    },
    async ({ query: { limit, offset }, organizationId }, reply) => {
      const [knowledgeBases, total] = await Promise.all([
        KnowledgeBaseModel.findByOrganization({
          organizationId,
          limit,
          offset,
        }),
        KnowledgeBaseModel.countByOrganization(organizationId),
      ]);

      const kbIds = knowledgeBases.map((kb) => kb.id);
      const [allConnectors, docsIndexedByKbId] = await Promise.all([
        KnowledgeBaseConnectorModel.findByKnowledgeBaseIds(kbIds),
        ConnectorRunModel.sumDocsIngestedByKnowledgeBaseIds(kbIds),
      ]);

      const connectorsByKbId = new Map<
        string,
        { id: string; name: string; connectorType: "jira" | "confluence" }[]
      >();
      for (const connector of allConnectors) {
        const list = connectorsByKbId.get(connector.knowledgeBaseId) ?? [];
        list.push({
          id: connector.id,
          name: connector.name,
          connectorType: connector.connectorType as "jira" | "confluence",
        });
        connectorsByKbId.set(connector.knowledgeBaseId, list);
      }

      const data = knowledgeBases.map((kb) => ({
        ...kb,
        connectors: connectorsByKbId.get(kb.id) ?? [],
        totalDocsIndexed: docsIndexedByKbId.get(kb.id) ?? 0,
      }));

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
          provider: KnowledgeBaseProviderTypeSchema,
          config: LightragConfigSchema,
          visibility: KnowledgeBaseVisibilitySchema.optional(),
          teamIds: z.array(z.string()).optional(),
        }),
        response: constructResponseSchema(SelectKnowledgeBaseSchema),
      },
    },
    async ({ body, organizationId }, reply) => {
      const kg = await KnowledgeBaseModel.create({
        organizationId,
        name: body.name,
        provider: body.provider,
        config: body.config,
        ...(body.description !== undefined && {
          description: body.description,
        }),
        ...(body.visibility && { visibility: body.visibility }),
        ...(body.teamIds && { teamIds: body.teamIds }),
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
    async ({ params: { id }, organizationId }, reply) => {
      const kg = await findKnowledgeBaseOrThrow(id, organizationId);
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
          config: LightragConfigSchema.optional(),
          visibility: KnowledgeBaseVisibilitySchema.optional(),
          teamIds: z.array(z.string()).optional(),
        }),
        response: constructResponseSchema(SelectKnowledgeBaseSchema),
      },
    },
    async ({ params: { id }, body, organizationId }, reply) => {
      await findKnowledgeBaseOrThrow(id, organizationId);

      const updated = await KnowledgeBaseModel.update(id, body);
      if (!updated) {
        throw new ApiError(404, "Knowledge graph not found");
      }

      return reply.send(updated);
    },
  );

  fastify.delete(
    "/api/knowledge-bases/:id",
    {
      schema: {
        operationId: RouteId.DeleteKnowledgeBase,
        description: "Delete a knowledge base and all its connectors",
        tags: ["Knowledge Bases"],
        params: z.object({ id: z.string() }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id }, organizationId }, reply) => {
      await findKnowledgeBaseOrThrow(id, organizationId);

      // Delete CronJobs for all connectors of this KG
      const connectors = await KnowledgeBaseConnectorModel.findByKnowledgeBase({
        knowledgeBaseId: id,
      });
      for (const connector of connectors) {
        try {
          await cronJobManager.deleteCronJob(connector.id);
        } catch (error) {
          logger.warn(
            {
              connectorId: connector.id,
              error: error instanceof Error ? error.message : String(error),
            },
            "[KnowledgeBase] Failed to delete CronJob during KG deletion",
          );
        }
      }

      const success = await KnowledgeBaseModel.delete(id);
      if (!success) {
        throw new ApiError(404, "Knowledge graph not found");
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
    async ({ params: { id }, organizationId }, reply) => {
      const kg = await findKnowledgeBaseOrThrow(id, organizationId);

      try {
        const provider = createKnowledgeBaseProvider(kg.provider, kg.config);

        const health = await provider.getHealth();
        return reply.send(health);
      } catch (error) {
        return reply.send({
          status: "unhealthy" as const,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  // ===== Connector Endpoints =====

  fastify.get(
    "/api/knowledge-bases/:kgId/connectors",
    {
      schema: {
        operationId: RouteId.GetConnectors,
        description: "List connectors for a knowledge base",
        tags: ["Knowledge Base Connectors"],
        params: z.object({ kgId: z.string() }),
        querystring: PaginationQuerySchema,
        response: constructResponseSchema(
          createPaginatedResponseSchema(SelectKnowledgeBaseConnectorSchema),
        ),
      },
    },
    async (
      { params: { kgId }, query: { limit, offset }, organizationId },
      reply,
    ) => {
      await findKnowledgeBaseOrThrow(kgId, organizationId);

      const [data, total] = await Promise.all([
        KnowledgeBaseConnectorModel.findByKnowledgeBase({
          knowledgeBaseId: kgId,
          limit,
          offset,
        }),
        KnowledgeBaseConnectorModel.countByKnowledgeBase(kgId),
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

  fastify.post(
    "/api/knowledge-bases/:kgId/connectors",
    {
      schema: {
        operationId: RouteId.CreateConnector,
        description: "Create a new connector for a knowledge base",
        tags: ["Knowledge Base Connectors"],
        params: z.object({ kgId: z.string() }),
        body: z.object({
          name: z.string().min(1),
          connectorType: ConnectorTypeSchema,
          config: ConnectorConfigSchema,
          credentials: ConnectorCredentialsSchema,
          schedule: z.string().optional(),
          enabled: z.boolean().optional(),
        }),
        response: constructResponseSchema(SelectKnowledgeBaseConnectorSchema),
      },
    },
    async ({ params: { kgId }, body, organizationId }, reply) => {
      await findKnowledgeBaseOrThrow(kgId, organizationId);

      // Validate connector config
      const connectorImpl = getConnector(body.connectorType);
      const validation = await connectorImpl.validateConfig(body.config);
      if (!validation.valid) {
        throw new ApiError(
          400,
          `Invalid connector configuration: ${validation.error}`,
        );
      }

      // Store credentials as a secret
      const secret = await secretManager().createSecret(
        body.credentials,
        `connector-${body.name}`,
      );

      // Create the connector
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        knowledgeBaseId: kgId,
        name: body.name,
        connectorType: body.connectorType,
        config: body.config,
        secretId: secret.id,
        schedule: body.schedule,
        enabled: body.enabled,
      });

      // Create CronJob if K8s is configured
      try {
        await cronJobManager.createOrUpdateCronJob({
          connectorId: connector.id,
          schedule: connector.schedule,
        });
      } catch (error) {
        logger.warn(
          {
            connectorId: connector.id,
            error: error instanceof Error ? error.message : String(error),
          },
          "[KnowledgeBase] Failed to create CronJob (K8s may not be configured)",
        );
      }

      return reply.send(connector);
    },
  );

  fastify.get(
    "/api/knowledge-bases/:kgId/connectors/:id",
    {
      schema: {
        operationId: RouteId.GetConnector,
        description: "Get a connector by ID",
        tags: ["Knowledge Base Connectors"],
        params: z.object({ kgId: z.string(), id: z.string() }),
        response: constructResponseSchema(SelectKnowledgeBaseConnectorSchema),
      },
    },
    async ({ params: { kgId, id }, organizationId }, reply) => {
      await findKnowledgeBaseOrThrow(kgId, organizationId);
      const connector = await findConnectorOrThrow(id, kgId);
      return reply.send(connector);
    },
  );

  fastify.put(
    "/api/knowledge-bases/:kgId/connectors/:id",
    {
      schema: {
        operationId: RouteId.UpdateConnector,
        description: "Update a connector",
        tags: ["Knowledge Base Connectors"],
        params: z.object({ kgId: z.string(), id: z.string() }),
        body: z.object({
          name: z.string().min(1).optional(),
          config: ConnectorConfigSchema.optional(),
          schedule: z.string().optional(),
          enabled: z.boolean().optional(),
        }),
        response: constructResponseSchema(SelectKnowledgeBaseConnectorSchema),
      },
    },
    async ({ params: { kgId, id }, body, organizationId }, reply) => {
      await findKnowledgeBaseOrThrow(kgId, organizationId);
      const existing = await findConnectorOrThrow(id, kgId);

      const updated = await KnowledgeBaseConnectorModel.update(id, body);
      if (!updated) {
        throw new ApiError(404, "Connector not found");
      }

      // Update CronJob if schedule changed
      if (body.schedule && body.schedule !== existing.schedule) {
        try {
          await cronJobManager.createOrUpdateCronJob({
            connectorId: id,
            schedule: body.schedule,
          });
        } catch (error) {
          logger.warn(
            {
              connectorId: id,
              error: error instanceof Error ? error.message : String(error),
            },
            "[KnowledgeBase] Failed to update CronJob",
          );
        }
      }

      // Suspend/resume CronJob if enabled changed
      if (body.enabled !== undefined && body.enabled !== existing.enabled) {
        try {
          if (body.enabled) {
            await cronJobManager.resumeCronJob(id);
          } else {
            await cronJobManager.suspendCronJob(id);
          }
        } catch (error) {
          logger.warn(
            {
              connectorId: id,
              error: error instanceof Error ? error.message : String(error),
            },
            "[KnowledgeBase] Failed to suspend/resume CronJob",
          );
        }
      }

      return reply.send(updated);
    },
  );

  fastify.delete(
    "/api/knowledge-bases/:kgId/connectors/:id",
    {
      schema: {
        operationId: RouteId.DeleteConnector,
        description: "Delete a connector",
        tags: ["Knowledge Base Connectors"],
        params: z.object({ kgId: z.string(), id: z.string() }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { kgId, id }, organizationId }, reply) => {
      await findKnowledgeBaseOrThrow(kgId, organizationId);
      const connector = await findConnectorOrThrow(id, kgId);

      // Delete the CronJob
      try {
        await cronJobManager.deleteCronJob(id);
      } catch (error) {
        logger.warn(
          {
            connectorId: id,
            error: error instanceof Error ? error.message : String(error),
          },
          "[KnowledgeBase] Failed to delete CronJob",
        );
      }

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
            "[KnowledgeBase] Failed to delete connector secret",
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
    "/api/knowledge-bases/:kgId/connectors/:id/sync",
    {
      schema: {
        operationId: RouteId.SyncConnector,
        description: "Manually trigger a connector sync",
        tags: ["Knowledge Base Connectors"],
        params: z.object({ kgId: z.string(), id: z.string() }),
        response: constructResponseSchema(
          z.object({
            runId: z.string(),
            status: z.string(),
          }),
        ),
      },
    },
    async ({ params: { kgId, id }, organizationId }, reply) => {
      await findKnowledgeBaseOrThrow(kgId, organizationId);
      await findConnectorOrThrow(id, kgId);

      const result = await connectorSyncService.executeSync(id);
      return reply.send(result);
    },
  );

  fastify.post(
    "/api/knowledge-bases/:kgId/connectors/:id/test",
    {
      schema: {
        operationId: RouteId.TestConnectorConnection,
        description: "Test a connector connection",
        tags: ["Knowledge Base Connectors"],
        params: z.object({ kgId: z.string(), id: z.string() }),
        response: constructResponseSchema(
          z.object({
            success: z.boolean(),
            error: z.string().optional(),
          }),
        ),
      },
    },
    async ({ params: { kgId, id }, organizationId }, reply) => {
      await findKnowledgeBaseOrThrow(kgId, organizationId);
      const connector = await findConnectorOrThrow(id, kgId);

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

  // ===== Connector Runs =====

  fastify.get(
    "/api/knowledge-bases/:kgId/connectors/:id/runs",
    {
      schema: {
        operationId: RouteId.GetConnectorRuns,
        description: "List connector runs",
        tags: ["Knowledge Base Connectors"],
        params: z.object({ kgId: z.string(), id: z.string() }),
        querystring: PaginationQuerySchema,
        response: constructResponseSchema(
          createPaginatedResponseSchema(SelectConnectorRunSchema),
        ),
      },
    },
    async (
      { params: { kgId, id }, query: { limit, offset }, organizationId },
      reply,
    ) => {
      await findKnowledgeBaseOrThrow(kgId, organizationId);
      await findConnectorOrThrow(id, kgId);

      const [data, total] = await Promise.all([
        ConnectorRunModel.findByConnector({ connectorId: id, limit, offset }),
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
    "/api/knowledge-bases/:kgId/connectors/:id/runs/:runId",
    {
      schema: {
        operationId: RouteId.GetConnectorRun,
        description: "Get a single connector run (including logs)",
        tags: ["Knowledge Base Connectors"],
        params: z.object({
          kgId: z.string(),
          id: z.string(),
          runId: z.string(),
        }),
        response: constructResponseSchema(SelectConnectorRunSchema),
      },
    },
    async ({ params: { kgId, id, runId }, organizationId }, reply) => {
      await findKnowledgeBaseOrThrow(kgId, organizationId);
      await findConnectorOrThrow(id, kgId);

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

async function findKnowledgeBaseOrThrow(id: string, organizationId: string) {
  const kg = await KnowledgeBaseModel.findById(id);
  if (!kg || kg.organizationId !== organizationId) {
    throw new ApiError(404, "Knowledge graph not found");
  }
  return kg;
}

async function findConnectorOrThrow(id: string, knowledgeBaseId: string) {
  const connector = await KnowledgeBaseConnectorModel.findById(id);
  if (!connector || connector.knowledgeBaseId !== knowledgeBaseId) {
    throw new ApiError(404, "Connector not found");
  }
  return connector;
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
