import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import mcpServerRuntimeManager from "@/k8s/mcp-server-runtime/manager";
import { namespaceAccessMessage } from "@/k8s/shared";
import logger from "@/logging";
import {
  EnvironmentModel,
  InternalMcpCatalogModel,
  McpServerModel,
} from "@/models";
import {
  createEnvironment,
  deleteEnvironment,
  listEnvironments,
  updateEnvironment,
} from "@/services/environments/environment";
import {
  createNetworkPolicy,
  deleteNetworkPolicy,
  listNetworkPolicies,
  updateNetworkPolicy,
} from "@/services/environments/network-policy";
import {
  ApiError,
  CreateEnvironmentSchema,
  CreateNetworkPolicySchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  EnvironmentListSchema,
  NetworkPolicyWithReferencesSchema,
  SelectEnvironmentSchema,
  SelectNetworkPolicySchema,
  UpdateEnvironmentSchema,
  UpdateNetworkPolicySchema,
  UuidIdSchema,
} from "@/types";

// Routes are thin: parse/validate (Zod), delegate to the service, serialize.
// All business logic (dup-name 409, not-found 404) lives in the service.
const environmentRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/organization/environments",
    {
      schema: {
        operationId: RouteId.ListEnvironments,
        description:
          "List org-level deployment environments with their assigned catalog counts, plus the count of catalog items with no environment (the default environment).",
        tags: ["Organization"],
        response: constructResponseSchema(EnvironmentListSchema),
      },
    },
    async ({ organizationId }, reply) => {
      return reply.send(await listEnvironments(organizationId));
    },
  );

  fastify.post(
    "/api/organization/environments",
    {
      schema: {
        operationId: RouteId.CreateEnvironment,
        description: "Create an org-level deployment environment.",
        tags: ["Organization"],
        body: CreateEnvironmentSchema,
        response: constructResponseSchema(SelectEnvironmentSchema),
      },
    },
    async ({ organizationId, body }, reply) => {
      if (body.namespace != null && mcpServerRuntimeManager.isEnabled) {
        try {
          await mcpServerRuntimeManager.validateNamespace(body.namespace);
        } catch (err) {
          throw new ApiError(
            400,
            err instanceof Error ? err.message : "Namespace validation failed",
          );
        }
      }
      return reply.send(
        await createEnvironment({ organizationId, data: body }),
      );
    },
  );

  fastify.patch(
    "/api/organization/environments/:id",
    {
      schema: {
        operationId: RouteId.UpdateEnvironment,
        description:
          "Update an environment's name, description, namespace, and restricted flag. When the namespace changes and the runtime is enabled, all MCP servers assigned to this environment are restarted in the new namespace.",
        tags: ["Organization"],
        params: z.object({ id: UuidIdSchema }),
        body: UpdateEnvironmentSchema,
        response: constructResponseSchema(SelectEnvironmentSchema),
      },
    },
    async ({ organizationId, params, body }, reply) => {
      const namespaceChanging = body.namespace !== undefined;

      // Validate that the new namespace actually exists in the cluster before
      // touching the DB — avoids a state where DB says "staging" but no such
      // namespace exists and pods can never start.
      if (
        namespaceChanging &&
        body.namespace !== null &&
        body.namespace !== undefined &&
        mcpServerRuntimeManager.isEnabled
      ) {
        try {
          await mcpServerRuntimeManager.validateNamespace(body.namespace);
        } catch (err) {
          throw new ApiError(
            400,
            err instanceof Error ? err.message : "Namespace validation failed",
          );
        }
      }

      // Capture old namespace before the update.
      const currentEnv = namespaceChanging
        ? await EnvironmentModel.findByIdForOrganization(
            params.id,
            organizationId,
          )
        : null;

      const namespaceActuallyChanging =
        namespaceChanging &&
        currentEnv !== null &&
        body.namespace !== (currentEnv?.namespace ?? null);

      // Pre-load deployments while the OLD namespace is still in the DB.
      // getOrLoadDeployment reads environmentId → namespace from the DB;
      // if we pre-load before the update, those in-memory K8sDeployment objects
      // still point at the old namespace so teardown targets the right place.
      let catalogsToRestart: { id: string; multitenant: boolean }[] = [];
      if (namespaceActuallyChanging && mcpServerRuntimeManager.isEnabled) {
        catalogsToRestart = await InternalMcpCatalogModel.findByEnvironmentId(
          params.id,
        );
        const servers = await McpServerModel.findByCatalogIds(
          catalogsToRestart.map((c) => c.id),
        );
        await Promise.all(
          servers.map((s) => mcpServerRuntimeManager.getOrLoadDeployment(s.id)),
        );
      }

      const updated = await updateEnvironment({
        id: params.id,
        organizationId,
        data: body,
      });

      // Restart affected servers into the new namespace.
      if (namespaceActuallyChanging && mcpServerRuntimeManager.isEnabled) {
        const servers = await McpServerModel.findByCatalogIds(
          catalogsToRestart.map((c) => c.id),
        );
        const multitenantCatalogIds = new Set(
          catalogsToRestart.filter((c) => c.multitenant).map((c) => c.id),
        );
        const singleTenantServers = servers.filter(
          (s) => s.catalogId && !multitenantCatalogIds.has(s.catalogId),
        );

        await Promise.allSettled([
          ...singleTenantServers.map(async (s) => {
            try {
              await mcpServerRuntimeManager.restartServer(s.id);
            } catch (err) {
              logger.warn(
                { mcpServerId: s.id, err },
                "Failed to restart server after environment namespace change",
              );
            }
          }),
          ...[...multitenantCatalogIds].map(async (catalogId) => {
            try {
              await mcpServerRuntimeManager.reinstallSharedDeployment(
                catalogId,
              );
            } catch (err) {
              logger.warn(
                { catalogId, err },
                "Failed to reinstall shared deployment after environment namespace change",
              );
            }
          }),
        ]);
      }

      return reply.send(updated);
    },
  );

  fastify.delete(
    "/api/organization/environments/:id",
    {
      schema: {
        operationId: RouteId.DeleteEnvironment,
        description:
          "Delete an org-level environment. Fails with 409 if any catalog items are still assigned to it.",
        tags: ["Organization"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ organizationId, params }, reply) => {
      await deleteEnvironment({ id: params.id, organizationId });
      return reply.send({ success: true });
    },
  );

  fastify.get(
    "/api/network-policies",
    {
      schema: {
        operationId: RouteId.ListNetworkPolicies,
        description: "List reusable organization network policies.",
        tags: ["Organization"],
        response: constructResponseSchema(
          z.array(NetworkPolicyWithReferencesSchema),
        ),
      },
    },
    async ({ organizationId }, reply) => {
      return reply.send(await listNetworkPolicies(organizationId));
    },
  );

  fastify.post(
    "/api/network-policies",
    {
      schema: {
        operationId: RouteId.CreateNetworkPolicy,
        description: "Create a reusable organization network policy.",
        tags: ["Organization"],
        body: CreateNetworkPolicySchema,
        response: constructResponseSchema(SelectNetworkPolicySchema),
      },
    },
    async ({ organizationId, body }, reply) => {
      return reply.send(
        await createNetworkPolicy({ organizationId, data: body }),
      );
    },
  );

  fastify.patch(
    "/api/network-policies/:id",
    {
      schema: {
        operationId: RouteId.UpdateNetworkPolicy,
        description: "Update a reusable organization network policy.",
        tags: ["Organization"],
        params: z.object({ id: UuidIdSchema }),
        body: UpdateNetworkPolicySchema,
        response: constructResponseSchema(SelectNetworkPolicySchema),
      },
    },
    async ({ organizationId, params, body }, reply) => {
      return reply.send(
        await updateNetworkPolicy({
          id: params.id,
          organizationId,
          data: body,
        }),
      );
    },
  );

  fastify.delete(
    "/api/network-policies/:id",
    {
      schema: {
        operationId: RouteId.DeleteNetworkPolicy,
        description:
          "Delete a reusable organization network policy. Fails with 409 while it is still assigned.",
        tags: ["Organization"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ organizationId, params }, reply) => {
      await deleteNetworkPolicy({ id: params.id, organizationId });
      return reply.send({ success: true });
    },
  );

  fastify.get(
    "/api/organization/environments/validate-namespace",
    {
      schema: {
        operationId: RouteId.ValidateEnvironmentNamespace,
        description:
          "Probe whether a Kubernetes namespace exists and is reachable. Returns accessible:true when the runtime is disabled (namespace will be stored but not verified).",
        tags: ["Organization"],
        querystring: z.object({ namespace: z.string().min(1) }),
        response: constructResponseSchema(
          z.discriminatedUnion("accessible", [
            z.object({ accessible: z.literal(true) }),
            z.object({
              accessible: z.literal(false),
              message: z.string(),
            }),
          ]),
        ),
      },
    },
    async ({ query }, reply) => {
      if (!mcpServerRuntimeManager.isEnabled) {
        return reply.send({ accessible: true });
      }

      const result = await mcpServerRuntimeManager.testNamespaceAccess(
        query.namespace,
      );

      if (result.accessible) {
        return reply.send({ accessible: true });
      }

      return reply.send({
        accessible: false,
        message: namespaceAccessMessage(query.namespace, result.reason),
      });
    },
  );
};

export default environmentRoutes;
