import { parseLabelsParam, RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import mcpServerRuntimeManager from "@/k8s/mcp-server-runtime/manager";
import {
  EnvironmentLabelModel,
  EnvironmentModel,
  InternalMcpCatalogModel,
  McpServerModel,
} from "@/models";
import { reconcileCatalogDeployments } from "@/services/environments/deployment-reconciliation";
import {
  createEnvironment,
  deleteEnvironment,
  listEnvironments,
  updateEnvironment,
  updateEnvironmentResourceDefaults,
} from "@/services/environments/environment";
import {
  assertNamespaceDeployableInEnvironmentCluster,
  testEnvironmentCluster,
} from "@/services/environments/environment-cluster";
import {
  ApiError,
  ClusterAgentInputSchema,
  CreateEnvironmentSchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  EnvironmentClusterTestResultSchema,
  EnvironmentListSchema,
  EnvironmentResourceDefaultsSchema,
  KubernetesNamespaceSchema,
  type NetworkPolicy,
  ReadEnvironmentSchema,
  SelectEnvironmentSchema,
  UpdateEnvironmentResourceDefaultsSchema,
  UpdateEnvironmentSchema,
  UuidIdSchema,
} from "@/types";
import { BulkDeleteBodySchema, BulkOutcomeSchema, runBulk } from "./bulk-route";
import { registerEntityLabelRoutes } from "./entity-labels";

// Routes are thin: parse/validate (Zod), delegate to the service, serialize.
// All business logic (dup-name 409, not-found 404) lives in the service.
const environmentRoutes: FastifyPluginAsyncZod = async (fastify) => {
  registerEntityLabelRoutes(fastify, {
    basePath: "/api/environments",
    tag: "Organization",
    entityNamePlural: "environments",
    model: EnvironmentLabelModel,
    keysOperationId: RouteId.GetEnvironmentLabelKeys,
    valuesOperationId: RouteId.GetEnvironmentLabelValues,
  });

  fastify.get(
    "/api/environments",
    {
      schema: {
        operationId: RouteId.ListEnvironments,
        description:
          "List org-level deployment environments with their assigned catalog counts, plus the count of catalog items with no environment (the default environment).",
        tags: ["Organization"],
        querystring: z.object({
          labels: z
            .string()
            .optional()
            .describe(
              "Filter by labels. Format: key1:val1|val2;key2:val3. AND across keys, OR within values.",
            ),
        }),
        response: constructResponseSchema(EnvironmentListSchema),
      },
    },
    async ({ organizationId, query, user }, reply) => {
      return reply.send(
        await listEnvironments({
          organizationId,
          userId: user.id,
          labels: parseLabelsParam(query.labels),
        }),
      );
    },
  );

  fastify.get(
    "/api/environments/:id",
    {
      schema: {
        operationId: RouteId.GetEnvironment,
        description: "Read an org-level deployment environment by ID.",
        tags: ["Organization"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(ReadEnvironmentSchema),
      },
    },
    async ({ organizationId, params }, reply) => {
      const environment = await EnvironmentModel.findByIdForOrganization(
        params.id,
        organizationId,
      );
      if (!environment) {
        throw new ApiError(404, "Environment not found");
      }
      const labels = await EnvironmentLabelModel.getLabelsForMany([
        environment.id,
      ]);
      return reply.send({
        ...environment,
        labels: labels.get(environment.id) ?? [],
      });
    },
  );

  fastify.patch(
    "/api/environments/defaults",
    {
      schema: {
        operationId: RouteId.UpdateEnvironmentResourceDefaults,
        description:
          "Configure which environment newly created resources of each kind land in when their creator does not pick one. Omitted kinds are left unchanged; an explicit null resets that kind to the default environment.",
        tags: ["Organization"],
        body: UpdateEnvironmentResourceDefaultsSchema,
        response: constructResponseSchema(EnvironmentResourceDefaultsSchema),
      },
    },
    async ({ organizationId, body }, reply) => {
      return reply.send(
        await updateEnvironmentResourceDefaults({ organizationId, data: body }),
      );
    },
  );

  fastify.post(
    "/api/environments",
    {
      schema: {
        operationId: RouteId.CreateEnvironment,
        description: "Create an org-level deployment environment.",
        tags: ["Organization"],
        body: CreateEnvironmentSchema,
        response: constructResponseSchema(SelectEnvironmentSchema),
      },
    },
    async ({ organizationId, body, user }, reply) => {
      // With a kubeconfig or a cluster agent the namespace is one of that
      // cluster, and the service checks it there.
      if (
        body.namespace != null &&
        !body.kubeconfig &&
        !body.clusterAgent &&
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
      return reply.send(
        await createEnvironment({
          organizationId,
          userId: user.id,
          data: body,
        }),
      );
    },
  );

  fastify.patch(
    "/api/environments/:id",
    {
      schema: {
        operationId: RouteId.UpdateEnvironment,
        description:
          "Update an environment's name, description, namespace, network policy, and restricted flag. When the namespace or network policy changes and the runtime is enabled, all MCP servers assigned to this environment are reconciled.",
        tags: ["Organization"],
        params: z.object({ id: UuidIdSchema }),
        body: UpdateEnvironmentSchema,
        response: constructResponseSchema(SelectEnvironmentSchema),
      },
    },
    async ({ organizationId, params, body }, reply) => {
      const namespaceChanging = body.namespace !== undefined;
      const networkPolicyChanging = body.networkPolicy !== undefined;

      // Capture old namespace before the update.
      const currentEnv =
        namespaceChanging || networkPolicyChanging
          ? await EnvironmentModel.findByIdForOrganization(
              params.id,
              organizationId,
            )
          : null;

      // Validate that the new namespace actually exists in the cluster before
      // touching the DB — avoids a state where DB says "staging" but no such
      // namespace exists and pods can never start. The cluster is the
      // environment's own when it has one.
      if (
        namespaceChanging &&
        body.namespace !== null &&
        body.namespace !== undefined &&
        mcpServerRuntimeManager.isEnabled
      ) {
        if (currentEnv?.kubeconfigServer) {
          // A replacement kubeconfig sent with the namespace is checked
          // against it by the update itself, with the new credential: the
          // stored one may be the reason it is being replaced. A namespace
          // that stays the same was checked when it was set.
          if (
            body.kubeconfig === undefined &&
            body.namespace !== currentEnv.namespace
          ) {
            await assertNamespaceDeployableInEnvironmentCluster({
              environment: currentEnv,
              namespace: body.namespace,
            });
          }
        } else {
          try {
            await mcpServerRuntimeManager.validateNamespace(body.namespace);
          } catch (err) {
            throw new ApiError(
              400,
              err instanceof Error
                ? err.message
                : "Namespace validation failed",
            );
          }
        }
      }
      if (
        namespaceChanging &&
        body.namespace === null &&
        currentEnv?.kubeconfigServer
      ) {
        throw new ApiError(
          400,
          "An environment with its own cluster needs a Kubernetes namespace in that cluster.",
        );
      }

      const namespaceActuallyChanging =
        namespaceChanging &&
        currentEnv !== null &&
        body.namespace !== (currentEnv?.namespace ?? null);
      const networkPolicyActuallyChanging =
        networkPolicyChanging &&
        currentEnv !== null &&
        !sameNetworkPolicy(
          body.networkPolicy ?? null,
          currentEnv.networkPolicy,
        );

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
      if (
        networkPolicyActuallyChanging &&
        !namespaceActuallyChanging &&
        mcpServerRuntimeManager.isEnabled
      ) {
        catalogsToRestart = await InternalMcpCatalogModel.findByEnvironmentId(
          params.id,
        );
      }

      const updated = await updateEnvironment({
        id: params.id,
        organizationId,
        data: body,
      });

      if (
        (namespaceActuallyChanging || networkPolicyActuallyChanging) &&
        mcpServerRuntimeManager.isEnabled
      ) {
        await reconcileCatalogDeployments({
          catalogs: catalogsToRestart,
          reason: namespaceActuallyChanging
            ? "environment namespace change"
            : "environment network policy change",
        });
      }

      return reply.send(updated);
    },
  );

  fastify.delete(
    "/api/environments/bulk",
    {
      schema: {
        operationId: RouteId.BulkDeleteEnvironments,
        description:
          "Delete several org-level environments in one request. An " +
          "environment that still has catalog items assigned to it cannot be " +
          "deleted; it is reported in `failed` with that reason while the " +
          "rest of the batch still applies.",
        tags: ["Organization"],
        body: BulkDeleteBodySchema,
        response: constructResponseSchema(BulkOutcomeSchema),
      },
    },
    async (request, reply) => {
      const { organizationId } = request;
      const snapshot = async (ids: string[]) => {
        const wanted = new Set(ids);
        const environments =
          await EnvironmentModel.listForOrganization(organizationId);
        return {
          environments: environments
            .filter((environment) => wanted.has(environment.id))
            .map(({ id, name }) => ({ id, name }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        };
      };

      const outcome = await runBulk({
        ids: request.body.ids,
        logLabel: "environments bulk delete",
        notFoundMessage: "Environment not found",
        unexpectedMessage: "Could not delete this environment",
        load: async (ids) => {
          const wanted = new Set(ids);
          const environments =
            await EnvironmentModel.listForOrganization(organizationId);
          return new Map(
            environments
              .filter((environment) => wanted.has(environment.id))
              .map((environment) => [environment.id, environment]),
          );
        },
        describe: (environment) => environment.name,
        // Reuses the single-environment service, so a batch refuses exactly
        // what one request would — an environment still in use answers 409,
        // which lands as this row's reason rather than as the batch's status.
        applyEach: async (_environment, id) => {
          await deleteEnvironment({ id, organizationId });
        },
        audit: { target: request, snapshot },
      });

      return reply.send(outcome);
    },
  );

  fastify.delete(
    "/api/environments/:id",
    {
      schema: {
        operationId: RouteId.DeleteEnvironment,
        description:
          "Delete an org-level environment. Fails with 409 if any catalog items are still assigned to it. An environment with its own cluster has its workloads removed from that cluster first; if that fails the delete fails with 409, unless `skipClusterCleanup` is set.",
        tags: ["Organization"],
        params: z.object({ id: UuidIdSchema }),
        querystring: z.object({
          skipClusterCleanup: z
            .enum(["true", "false"])
            .optional()
            .describe(
              "Delete the environment even when its workloads could not be removed from its own cluster; they are left there.",
            ),
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ organizationId, params, query }, reply) => {
      await deleteEnvironment({
        id: params.id,
        organizationId,
        skipClusterCleanup: query.skipClusterCleanup === "true",
      });
      return reply.send({ success: true });
    },
  );

  fastify.post(
    "/api/environments/kubeconfig/test",
    {
      schema: {
        operationId: RouteId.TestEnvironmentKubeconfig,
        description:
          "Test a kubeconfig or a cluster agent before creating an environment with it: reports, per feature, what its cluster lets the platform do in the given namespace. Nothing is stored or deployed.",
        tags: ["Organization"],
        body: z.object({
          kubeconfig: z.string().min(1).optional(),
          clusterAgent: ClusterAgentInputSchema.optional(),
          namespace: KubernetesNamespaceSchema,
          agentRuntimePlatformBaseUrl: z.string().nullable().optional(),
        }),
        response: constructResponseSchema(EnvironmentClusterTestResultSchema),
      },
    },
    async ({ organizationId, body }, reply) => {
      return reply.send(
        await testEnvironmentCluster({ organizationId, ...body }),
      );
    },
  );

  fastify.post(
    "/api/environments/:id/cluster/test",
    {
      schema: {
        operationId: RouteId.TestEnvironmentCluster,
        description:
          "Test the cluster of an environment that has its own: reports, per feature, what the cluster lets the platform do. With `kubeconfig` or `clusterAgentToken`, tests that credential instead of the stored one. Nothing is stored or deployed.",
        tags: ["Organization"],
        params: z.object({ id: UuidIdSchema }),
        body: z.object({
          kubeconfig: z.string().min(1).optional(),
          clusterAgentToken: z.string().min(1).optional(),
          namespace: KubernetesNamespaceSchema.optional(),
          agentRuntimePlatformBaseUrl: z.string().nullable().optional(),
        }),
        response: constructResponseSchema(EnvironmentClusterTestResultSchema),
      },
    },
    async ({ organizationId, params, body }, reply) => {
      return reply.send(
        await testEnvironmentCluster({
          organizationId,
          environmentId: params.id,
          ...body,
        }),
      );
    },
  );
};

export default environmentRoutes;

// === Internal helpers ===

function sameNetworkPolicy(
  a: NetworkPolicy | null,
  b: NetworkPolicy | null,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
