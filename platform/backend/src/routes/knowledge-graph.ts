import { createHmac, timingSafeEqual } from "node:crypto";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import { getConnector } from "@/connectors/registry";
import type { ConnectorCredentials } from "@/connectors/types";
import { cronJobManager } from "@/k8s/cron-job";
import { createKnowledgeGraphProvider } from "@/knowledge-graph";
import logger from "@/logging";
import {
  ConnectorRunModel,
  KnowledgeGraphConnectorModel,
  KnowledgeGraphModel,
} from "@/models";
import { secretManager } from "@/secrets-manager";
import { connectorSyncService } from "@/services/connector-sync";
import {
  ApiError,
  constructResponseSchema,
  createPaginatedResponseSchema,
  DeleteObjectResponseSchema,
  type KnowledgeGraphConfig,
  PaginationQuerySchema,
  SelectConnectorRunSchema,
  SelectKnowledgeGraphConnectorSchema,
  SelectKnowledgeGraphSchema,
} from "@/types";

const knowledgeGraphRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // ===== Knowledge Graph CRUD =====

  fastify.get(
    "/api/knowledge-graphs",
    {
      schema: {
        operationId: RouteId.GetKnowledgeGraphs,
        description: "List all knowledge graphs for the organization",
        tags: ["Knowledge Graphs"],
        querystring: PaginationQuerySchema,
        response: constructResponseSchema(
          createPaginatedResponseSchema(SelectKnowledgeGraphSchema),
        ),
      },
    },
    async ({ query: { limit, offset }, organizationId }, reply) => {
      const [data, total] = await Promise.all([
        KnowledgeGraphModel.findByOrganization({
          organizationId,
          limit,
          offset,
        }),
        KnowledgeGraphModel.countByOrganization(organizationId),
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
    "/api/knowledge-graphs",
    {
      schema: {
        operationId: RouteId.CreateKnowledgeGraph,
        description: "Create a new knowledge graph",
        tags: ["Knowledge Graphs"],
        body: z.object({
          name: z.string().min(1),
          provider: z.string().min(1),
          config: z.record(z.string(), z.unknown()),
        }),
        response: constructResponseSchema(SelectKnowledgeGraphSchema),
      },
    },
    async ({ body, organizationId }, reply) => {
      const kg = await KnowledgeGraphModel.create({
        organizationId,
        name: body.name,
        provider: body.provider,
        config: body.config,
      });

      return reply.send(kg);
    },
  );

  fastify.get(
    "/api/knowledge-graphs/:id",
    {
      schema: {
        operationId: RouteId.GetKnowledgeGraph,
        description: "Get a knowledge graph by ID",
        tags: ["Knowledge Graphs"],
        params: z.object({ id: z.string() }),
        response: constructResponseSchema(SelectKnowledgeGraphSchema),
      },
    },
    async ({ params: { id }, organizationId }, reply) => {
      const kg = await findKnowledgeGraphOrThrow(id, organizationId);
      return reply.send(kg);
    },
  );

  fastify.put(
    "/api/knowledge-graphs/:id",
    {
      schema: {
        operationId: RouteId.UpdateKnowledgeGraph,
        description: "Update a knowledge graph",
        tags: ["Knowledge Graphs"],
        params: z.object({ id: z.string() }),
        body: z.object({
          name: z.string().min(1).optional(),
          config: z.record(z.string(), z.unknown()).optional(),
        }),
        response: constructResponseSchema(SelectKnowledgeGraphSchema),
      },
    },
    async ({ params: { id }, body, organizationId }, reply) => {
      await findKnowledgeGraphOrThrow(id, organizationId);

      const updated = await KnowledgeGraphModel.update(id, body);
      if (!updated) {
        throw new ApiError(404, "Knowledge graph not found");
      }

      return reply.send(updated);
    },
  );

  fastify.delete(
    "/api/knowledge-graphs/:id",
    {
      schema: {
        operationId: RouteId.DeleteKnowledgeGraph,
        description: "Delete a knowledge graph and all its connectors",
        tags: ["Knowledge Graphs"],
        params: z.object({ id: z.string() }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id }, organizationId }, reply) => {
      await findKnowledgeGraphOrThrow(id, organizationId);

      // Delete CronJobs for all connectors of this KG
      const connectors =
        await KnowledgeGraphConnectorModel.findByKnowledgeGraph({
          knowledgeGraphId: id,
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
            "[KnowledgeGraph] Failed to delete CronJob during KG deletion",
          );
        }
      }

      const success = await KnowledgeGraphModel.delete(id);
      if (!success) {
        throw new ApiError(404, "Knowledge graph not found");
      }

      return reply.send({ success: true });
    },
  );

  fastify.get(
    "/api/knowledge-graphs/:id/health",
    {
      schema: {
        operationId: RouteId.GetKnowledgeGraphHealth,
        description: "Check the health of a knowledge graph",
        tags: ["Knowledge Graphs"],
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
      const kg = await findKnowledgeGraphOrThrow(id, organizationId);

      try {
        const kgConfig: KnowledgeGraphConfig = {
          provider: kg.provider as KnowledgeGraphConfig["provider"],
          lightrag:
            kg.provider === "lightrag"
              ? (kg.config as KnowledgeGraphConfig["lightrag"])
              : undefined,
        };

        const provider = createKnowledgeGraphProvider(
          kg.provider as NonNullable<KnowledgeGraphConfig["provider"]>,
          kgConfig,
        );

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
    "/api/knowledge-graphs/:kgId/connectors",
    {
      schema: {
        operationId: RouteId.GetConnectors,
        description: "List connectors for a knowledge graph",
        tags: ["Knowledge Graph Connectors"],
        params: z.object({ kgId: z.string() }),
        querystring: PaginationQuerySchema,
        response: constructResponseSchema(
          createPaginatedResponseSchema(SelectKnowledgeGraphConnectorSchema),
        ),
      },
    },
    async (
      { params: { kgId }, query: { limit, offset }, organizationId },
      reply,
    ) => {
      await findKnowledgeGraphOrThrow(kgId, organizationId);

      const [data, total] = await Promise.all([
        KnowledgeGraphConnectorModel.findByKnowledgeGraph({
          knowledgeGraphId: kgId,
          limit,
          offset,
        }),
        KnowledgeGraphConnectorModel.countByKnowledgeGraph(kgId),
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
    "/api/knowledge-graphs/:kgId/connectors",
    {
      schema: {
        operationId: RouteId.CreateConnector,
        description: "Create a new connector for a knowledge graph",
        tags: ["Knowledge Graph Connectors"],
        params: z.object({ kgId: z.string() }),
        body: z.object({
          name: z.string().min(1),
          connectorType: z.string().min(1),
          config: z.record(z.string(), z.unknown()),
          credentials: z.object({
            email: z.string(),
            apiToken: z.string(),
          }),
          schedule: z.string().optional(),
          enabled: z.boolean().optional(),
        }),
        response: constructResponseSchema(SelectKnowledgeGraphConnectorSchema),
      },
    },
    async ({ params: { kgId }, body, organizationId }, reply) => {
      await findKnowledgeGraphOrThrow(kgId, organizationId);

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
      const connector = await KnowledgeGraphConnectorModel.create({
        organizationId,
        knowledgeGraphId: kgId,
        name: body.name,
        connectorType: body.connectorType,
        config: body.config,
        secretId: secret.id,
        schedule: body.schedule,
        enabled: body.enabled,
      });

      // Create CronJob if K8s is configured
      try {
        const hmacSecret = config.auth.secret || "";
        const backendUrl = `http://localhost:${config.api.port}`;

        await cronJobManager.createOrUpdateCronJob({
          connectorId: connector.id,
          schedule: connector.schedule,
          backendUrl,
          hmacSecret,
        });
      } catch (error) {
        logger.warn(
          {
            connectorId: connector.id,
            error: error instanceof Error ? error.message : String(error),
          },
          "[KnowledgeGraph] Failed to create CronJob (K8s may not be configured)",
        );
      }

      return reply.send(connector);
    },
  );

  fastify.get(
    "/api/knowledge-graphs/:kgId/connectors/:id",
    {
      schema: {
        operationId: RouteId.GetConnector,
        description: "Get a connector by ID",
        tags: ["Knowledge Graph Connectors"],
        params: z.object({ kgId: z.string(), id: z.string() }),
        response: constructResponseSchema(SelectKnowledgeGraphConnectorSchema),
      },
    },
    async ({ params: { kgId, id }, organizationId }, reply) => {
      await findKnowledgeGraphOrThrow(kgId, organizationId);
      const connector = await findConnectorOrThrow(id, kgId);
      return reply.send(connector);
    },
  );

  fastify.put(
    "/api/knowledge-graphs/:kgId/connectors/:id",
    {
      schema: {
        operationId: RouteId.UpdateConnector,
        description: "Update a connector",
        tags: ["Knowledge Graph Connectors"],
        params: z.object({ kgId: z.string(), id: z.string() }),
        body: z.object({
          name: z.string().min(1).optional(),
          config: z.record(z.string(), z.unknown()).optional(),
          schedule: z.string().optional(),
          enabled: z.boolean().optional(),
        }),
        response: constructResponseSchema(SelectKnowledgeGraphConnectorSchema),
      },
    },
    async ({ params: { kgId, id }, body, organizationId }, reply) => {
      await findKnowledgeGraphOrThrow(kgId, organizationId);
      const existing = await findConnectorOrThrow(id, kgId);

      const updated = await KnowledgeGraphConnectorModel.update(id, body);
      if (!updated) {
        throw new ApiError(404, "Connector not found");
      }

      // Update CronJob if schedule changed
      if (body.schedule && body.schedule !== existing.schedule) {
        try {
          const hmacSecret = config.auth.secret || "";
          const backendUrl = `http://localhost:${config.api.port}`;

          await cronJobManager.createOrUpdateCronJob({
            connectorId: id,
            schedule: body.schedule,
            backendUrl,
            hmacSecret,
          });
        } catch (error) {
          logger.warn(
            {
              connectorId: id,
              error: error instanceof Error ? error.message : String(error),
            },
            "[KnowledgeGraph] Failed to update CronJob",
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
            "[KnowledgeGraph] Failed to suspend/resume CronJob",
          );
        }
      }

      return reply.send(updated);
    },
  );

  fastify.delete(
    "/api/knowledge-graphs/:kgId/connectors/:id",
    {
      schema: {
        operationId: RouteId.DeleteConnector,
        description: "Delete a connector",
        tags: ["Knowledge Graph Connectors"],
        params: z.object({ kgId: z.string(), id: z.string() }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { kgId, id }, organizationId }, reply) => {
      await findKnowledgeGraphOrThrow(kgId, organizationId);
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
          "[KnowledgeGraph] Failed to delete CronJob",
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
            "[KnowledgeGraph] Failed to delete connector secret",
          );
        }
      }

      const success = await KnowledgeGraphConnectorModel.delete(id);
      if (!success) {
        throw new ApiError(404, "Connector not found");
      }

      return reply.send({ success: true });
    },
  );

  fastify.post(
    "/api/knowledge-graphs/:kgId/connectors/:id/sync",
    {
      schema: {
        operationId: RouteId.SyncConnector,
        description: "Manually trigger a connector sync",
        tags: ["Knowledge Graph Connectors"],
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
      await findKnowledgeGraphOrThrow(kgId, organizationId);
      await findConnectorOrThrow(id, kgId);

      const result = await connectorSyncService.executeSync(id);
      return reply.send(result);
    },
  );

  fastify.post(
    "/api/knowledge-graphs/:kgId/connectors/:id/test",
    {
      schema: {
        operationId: RouteId.TestConnectorConnection,
        description: "Test a connector connection",
        tags: ["Knowledge Graph Connectors"],
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
      await findKnowledgeGraphOrThrow(kgId, organizationId);
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
    "/api/knowledge-graphs/:kgId/connectors/:id/runs",
    {
      schema: {
        operationId: RouteId.GetConnectorRuns,
        description: "List connector runs",
        tags: ["Knowledge Graph Connectors"],
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
      await findKnowledgeGraphOrThrow(kgId, organizationId);
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

  // ===== Internal Route: CronJob Callback =====

  fastify.post(
    "/api/internal/connectors/:connectorId/sync",
    {
      schema: {
        description: "Internal endpoint called by K8s CronJobs to trigger sync",
        tags: ["Internal"],
        params: z.object({ connectorId: z.string() }),
        response: constructResponseSchema(
          z.object({
            runId: z.string(),
            status: z.string(),
          }),
        ),
      },
    },
    async ({ params: { connectorId }, headers }, reply) => {
      // Validate HMAC signature from CronJob
      const signature = headers["x-archestra-signature"] as string | undefined;
      const timestamp = headers["x-archestra-timestamp"] as string | undefined;

      if (!signature || !timestamp) {
        throw new ApiError(401, "Missing signature or timestamp");
      }

      const hmacSecret = config.auth.secret || "";
      const expectedSignature = createHmac("sha256", hmacSecret)
        .update(timestamp)
        .digest("hex");

      const sigBuffer = Buffer.from(signature, "hex");
      const expectedBuffer = Buffer.from(expectedSignature, "hex");

      if (
        sigBuffer.length !== expectedBuffer.length ||
        !timingSafeEqual(sigBuffer, expectedBuffer)
      ) {
        throw new ApiError(401, "Invalid signature");
      }

      // Verify timestamp is not too old (5 minutes window)
      const timestampNum = Number.parseInt(timestamp, 10);
      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(now - timestampNum) > 300) {
        throw new ApiError(401, "Timestamp too old");
      }

      const result = await connectorSyncService.executeSync(connectorId);
      return reply.send(result);
    },
  );
};

export default knowledgeGraphRoutes;

// ===== Internal Helpers =====

async function findKnowledgeGraphOrThrow(id: string, organizationId: string) {
  const kg = await KnowledgeGraphModel.findById(id);
  if (!kg || kg.organizationId !== organizationId) {
    throw new ApiError(404, "Knowledge graph not found");
  }
  return kg;
}

async function findConnectorOrThrow(id: string, knowledgeGraphId: string) {
  const connector = await KnowledgeGraphConnectorModel.findById(id);
  if (!connector || connector.knowledgeGraphId !== knowledgeGraphId) {
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
