import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import mcpServerRuntimeManager from "@/k8s/mcp-server-runtime/manager";
import {
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
  ApiError,
  CreateEnvironmentSchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  EnvironmentListSchema,
  EnvironmentResourceDefaultsSchema,
  type NetworkPolicy,
  SelectEnvironmentSchema,
  UpdateEnvironmentResourceDefaultsSchema,
  UpdateEnvironmentSchema,
  UuidIdSchema,
} from "@/types";
import { BulkDeleteBodySchema, BulkOutcomeSchema, runBulk } from "./bulk-route";

// Routes are thin: parse/validate (Zod), delegate to the service, serialize.
// All business logic (dup-name 409, not-found 404) lives in the service.
const environmentRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/environments",
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
      const currentEnv =
        namespaceChanging || networkPolicyChanging
          ? await EnvironmentModel.findByIdForOrganization(
              params.id,
              organizationId,
            )
          : null;

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
};

export default environmentRoutes;

// === Internal helpers ===

function sameNetworkPolicy(
  a: NetworkPolicy | null,
  b: NetworkPolicy | null,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
