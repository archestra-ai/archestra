import * as k8s from "@kubernetes/client-node";
import { RouteId } from "@shared";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import config from "@/config";
import { clusterRegistry } from "@/k8s/mcp-server-runtime/cluster-registry";
import { buildKubeConfig } from "@/k8s/shared";
import logger from "@/logging";
import ClusterModel from "@/models/cluster";
import SecretModel from "@/models/secret";
import {
  ApiError,
  ClusterInUseError,
  constructResponseSchema,
  InsertClusterInputSchema,
  SelectClusterSchema,
  UpdateClusterInputSchema,
} from "@/types";

const KUBECONFIG_SECRET_KEY = "kubeconfig";
const ClusterIdParamsSchema = z.object({ id: z.uuid() });

const TestClusterResponseSchema = z.object({
  ok: z.boolean(),
  namespacesVisible: z.number().optional(),
  error: z.string().optional(),
});

const InsertClusterRequestSchema = InsertClusterInputSchema.extend({
  isDefault: z.unknown().optional(),
});

const UpdateClusterRequestSchema = UpdateClusterInputSchema.extend({
  isDefault: z.unknown().optional(),
});

async function requireAdmin(request: FastifyRequest): Promise<void> {
  if (!request.user) {
    throw new ApiError(401, "Unauthorized");
  }
  const { success } = await hasPermission(
    { mcpServerInstallation: ["admin"] },
    request.headers,
  );
  if (!success) {
    throw new ApiError(403, "Forbidden");
  }
}

const clusterRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/clusters",
    {
      schema: {
        operationId: RouteId.GetClusters,
        description: "List all configured clusters",
        tags: ["Clusters"],
        response: constructResponseSchema(z.array(SelectClusterSchema)),
      },
    },
    async (request, reply) => {
      await requireAdmin(request);
      return reply.send(await ClusterModel.list());
    },
  );

  fastify.get(
    "/api/clusters/:id",
    {
      schema: {
        operationId: RouteId.GetCluster,
        description: "Get a cluster by ID",
        tags: ["Clusters"],
        params: ClusterIdParamsSchema,
        response: constructResponseSchema(SelectClusterSchema),
      },
    },
    async (request, reply) => {
      await requireAdmin(request);
      const cluster = await ClusterModel.getById(request.params.id);
      if (!cluster) {
        throw new ApiError(404, "Cluster not found");
      }
      return reply.send(cluster);
    },
  );

  fastify.post(
    "/api/clusters",
    {
      schema: {
        operationId: RouteId.CreateCluster,
        description: "Create a new cluster",
        tags: ["Clusters"],
        body: InsertClusterRequestSchema,
        response: {
          ...constructResponseSchema(SelectClusterSchema),
          201: SelectClusterSchema,
        },
      },
    },
    async (request, reply) => {
      await requireAdmin(request);
      const { isDefault, ...input } = request.body;
      if (isDefault !== undefined) {
        throw new ApiError(400, "isDefault cannot be set on cluster create");
      }
      try {
        const created = await ClusterModel.create(input);
        return reply.status(201).send(created);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new ApiError(400, message);
      }
    },
  );

  fastify.patch(
    "/api/clusters/:id",
    {
      schema: {
        operationId: RouteId.UpdateCluster,
        description: "Update a cluster",
        tags: ["Clusters"],
        params: ClusterIdParamsSchema,
        body: UpdateClusterRequestSchema,
        response: constructResponseSchema(SelectClusterSchema),
      },
    },
    async (request, reply) => {
      await requireAdmin(request);
      const { id } = request.params;
      const { isDefault, ...patch } = request.body;
      if (isDefault !== undefined) {
        throw new ApiError(400, "isDefault cannot be changed on a cluster");
      }

      const existing = await ClusterModel.getById(id);
      if (!existing) {
        throw new ApiError(404, "Cluster not found");
      }

      try {
        const updated = await ClusterModel.update(id, patch);
        clusterRegistry.invalidate(id);
        return reply.send(updated);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new ApiError(400, message);
      }
    },
  );

  fastify.delete(
    "/api/clusters/:id",
    {
      schema: {
        operationId: RouteId.DeleteCluster,
        description: "Delete a cluster",
        tags: ["Clusters"],
        params: ClusterIdParamsSchema,
        response: {
          ...constructResponseSchema(z.null()),
          204: z.null(),
        },
      },
    },
    async (request, reply) => {
      await requireAdmin(request);
      const { id } = request.params;
      const existing = await ClusterModel.getById(id);
      if (!existing) {
        throw new ApiError(404, "Cluster not found");
      }

      try {
        await ClusterModel.delete(id);
      } catch (err) {
        if (err instanceof ClusterInUseError) {
          throw new ApiError(409, err.message);
        }
        const message = err instanceof Error ? err.message : String(err);
        throw new ApiError(400, message);
      }
      clusterRegistry.invalidate(id);
      return reply.status(204).send(null);
    },
  );

  fastify.post(
    "/api/clusters/:id/test",
    {
      schema: {
        operationId: RouteId.TestCluster,
        description: "Test connection to a cluster's Kubernetes API",
        tags: ["Clusters"],
        params: ClusterIdParamsSchema,
        response: constructResponseSchema(TestClusterResponseSchema),
      },
    },
    async (request, reply) => {
      await requireAdmin(request);
      const { id } = request.params;
      const cluster = await ClusterModel.getById(id);
      if (!cluster) {
        throw new ApiError(404, "Cluster not found");
      }

      try {
        const isDefaultEnvFallback =
          cluster.name === "default" &&
          cluster.kubeconfigSecretId === null &&
          cluster.loadFromCluster === false &&
          cluster.namespace === null;

        let kubeconfigYaml: string | undefined;
        if (cluster.kubeconfigSecretId) {
          const secret = await SecretModel.findById(cluster.kubeconfigSecretId);
          const blob = secret?.secret as
            | { [KUBECONFIG_SECRET_KEY]?: string }
            | undefined;
          kubeconfigYaml = blob?.[KUBECONFIG_SECRET_KEY];
        }

        const { kubeConfig } = isDefaultEnvFallback
          ? buildKubeConfig({
              kubeconfigPath: config.orchestrator.kubernetes.kubeconfig,
              loadFromCluster:
                config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster,
              namespace:
                cluster.namespace ?? config.orchestrator.kubernetes.namespace,
            })
          : buildKubeConfig({
              kubeconfigYaml,
              loadFromCluster: cluster.loadFromCluster,
              namespace: cluster.namespace ?? "default",
            });

        const coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);
        const result = await coreApi.listNamespace({ limit: 5 });
        return reply.send({
          ok: true,
          namespacesVisible: result.items.length,
        });
      } catch (error) {
        logger.warn(
          { clusterId: id, err: error },
          "Cluster test connection failed",
        );
        return reply.send({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
};

export default clusterRoutes;
