import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import McpServerRuntimeManager from "@/k8s/mcp-server-runtime/manager";
import { loadKubeConfigFromString } from "@/k8s/shared";
import { K8sClusterModel } from "@/models";
import {
  ApiError,
  CreateK8sClusterBodySchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  SelectK8sClusterSchema,
  UpdateK8sClusterSchema,
  UuidIdSchema,
} from "@/types";

const DEFAULT_CLUSTER_ENTRY = { id: null, name: "Default (platform cluster)" };

const K8sClusterListItemSchema = z.union([
  z.object({ id: z.null(), name: z.string() }),
  SelectK8sClusterSchema,
]);

const k8sRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/k8s/clusters",
    {
      schema: {
        operationId: RouteId.ListK8sClusters,
        description: "List Kubernetes clusters registered for the organization",
        tags: ["K8s"],
        response: constructResponseSchema(
          z.object({ clusters: z.array(K8sClusterListItemSchema) }),
        ),
      },
    },
    async (request, reply) => {
      const { success } = await hasPermission(
        { mcpServerInstallation: ["read"] },
        request.headers,
      );
      if (!success) throw new ApiError(403, "Forbidden");

      const clusters = await K8sClusterModel.findAll(request.organizationId);
      return reply.send({
        clusters: [DEFAULT_CLUSTER_ENTRY, ...clusters],
      });
    },
  );

  fastify.post(
    "/api/k8s/clusters",
    {
      schema: {
        operationId: RouteId.CreateK8sCluster,
        description:
          "Register a custom Kubernetes cluster for the organization",
        tags: ["K8s"],
        body: CreateK8sClusterBodySchema,
        response: constructResponseSchema(SelectK8sClusterSchema),
      },
    },
    async (request, reply) => {
      const { success } = await hasPermission(
        { mcpServerInstallation: ["admin"] },
        request.headers,
      );
      if (!success) throw new ApiError(403, "Forbidden");

      const { name, kubeconfig } = request.body;

      try {
        loadKubeConfigFromString(kubeconfig);
      } catch (err) {
        throw new ApiError(
          400,
          err instanceof Error ? err.message : "Invalid kubeconfig",
        );
      }

      const cluster = await K8sClusterModel.create({
        organizationId: request.organizationId,
        name,
        kubeconfig,
      });

      return reply.send(cluster);
    },
  );

  fastify.put(
    "/api/k8s/clusters/:id",
    {
      schema: {
        operationId: RouteId.UpdateK8sCluster,
        description: "Update a custom Kubernetes cluster",
        tags: ["K8s"],
        params: z.object({ id: UuidIdSchema }),
        body: UpdateK8sClusterSchema,
        response: constructResponseSchema(SelectK8sClusterSchema),
      },
    },
    async (request, reply) => {
      const { success } = await hasPermission(
        { mcpServerInstallation: ["admin"] },
        request.headers,
      );
      if (!success) throw new ApiError(403, "Forbidden");

      if (request.body.kubeconfig) {
        try {
          loadKubeConfigFromString(request.body.kubeconfig);
        } catch (err) {
          throw new ApiError(
            400,
            err instanceof Error ? err.message : "Invalid kubeconfig",
          );
        }
      }

      const cluster = await K8sClusterModel.update(
        request.params.id,
        request.organizationId,
        request.body,
      );

      return reply.send(cluster);
    },
  );

  fastify.delete(
    "/api/k8s/clusters/:id",
    {
      schema: {
        operationId: RouteId.DeleteK8sCluster,
        description: "Delete a custom Kubernetes cluster",
        tags: ["K8s"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async (request, reply) => {
      const { success } = await hasPermission(
        { mcpServerInstallation: ["admin"] },
        request.headers,
      );
      if (!success) throw new ApiError(403, "Forbidden");

      const cluster = await K8sClusterModel.findById(
        request.params.id,
        request.organizationId,
      );
      if (!cluster) {
        throw new ApiError(404, "K8s cluster not found");
      }

      await K8sClusterModel.delete(request.params.id, request.organizationId);

      return reply.send({ success: true });
    },
  );

  fastify.get(
    "/api/k8s/namespaces",
    {
      schema: {
        operationId: RouteId.ListK8sNamespaces,
        description: "List Kubernetes namespaces for a cluster",
        tags: ["K8s"],
        querystring: z.object({
          clusterId: UuidIdSchema.optional(),
        }),
        response: constructResponseSchema(
          z.object({
            namespaces: z.array(z.string()),
            defaultNamespace: z.string(),
          }),
        ),
      },
    },
    async (request, reply) => {
      const { success } = await hasPermission(
        { mcpServerInstallation: ["read"] },
        request.headers,
      );
      if (!success) throw new ApiError(403, "Forbidden");

      const { clusterId } = request.query;

      let cluster = null;
      if (clusterId) {
        cluster = await K8sClusterModel.findById(
          clusterId,
          request.organizationId,
        );
        if (!cluster) {
          throw new ApiError(404, "K8s cluster not found");
        }
      }

      const namespaces = await McpServerRuntimeManager.listNamespaces(cluster);
      const defaultNamespace = McpServerRuntimeManager.getDefaultNamespace();

      return reply.send({ namespaces, defaultNamespace });
    },
  );
};

export default k8sRoutes;
