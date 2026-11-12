import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import logger from "@/logging";
import { openappaGithubAppSetup } from "@/services/openappa-github-app-setup";
import {
  configureAppaGithubSync,
  createAppaGithubRepository,
  getAppaGithubAppGrants,
  getAppaGithubSync,
  getAppaSelfService,
  getRepositoryProtection,
  selfServiceInForce,
  updateAppaGithubSync,
} from "@/services/openappa-github-sync";
import {
  ensureSelfServiceInclude,
  selfServiceIncludeState,
} from "@/services/openappa-server-rules";
import { constructResponseSchema, DeleteObjectResponseSchema } from "@/types";
import {
  AppaGithubAppAccountsSchema,
  AppaGithubAppInstallResultSchema,
  AppaGithubAppManifestSchema,
  AppaGithubAppRepositoriesQuerySchema,
  AppaGithubAppRepositoriesSchema,
  AppaGithubRepositoryQuerySchema,
  AppaGithubRepositoryStatusSchema,
  CompleteAppaGithubAppSchema,
  PendingAppaGithubAppSchema,
  StartAppaGithubAppSchema,
} from "@/types/openappa-github-app-setup";
import {
  AppaGithubAppGrantsSchema,
  AppaGithubSourceSchema,
  AppaGithubSyncActionSchema,
  AppaGithubSyncStatusSchema,
  AppaRepositoryProtectionSchema,
  AppaSelfServiceAvailabilitySchema,
  CreateAppaGithubRepositorySchema,
} from "@/types/openappa-github-sync";

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/api/openappa/github-sync",
    {
      schema: {
        operationId: RouteId.GetAppaGithubSync,
        tags: ["OpenAPPA"],
        response: constructResponseSchema(AppaGithubSyncStatusSchema),
      },
    },
    async (request, reply) =>
      reply.send(await getAppaGithubSync(request.organizationId)),
  );
  app.get(
    "/api/openappa/github-sync/protection",
    {
      schema: {
        operationId: RouteId.GetAppaRepositoryProtection,
        tags: ["OpenAPPA"],
        response: constructResponseSchema(AppaRepositoryProtectionSchema),
      },
    },
    async (request, reply) => {
      const protection = await getRepositoryProtection(request.organizationId);
      return reply.send(
        protection && {
          ...protection,
          include: await selfServiceIncludeState(request.organizationId),
        },
      );
    },
  );
  app.get(
    "/api/openappa/github-sync/app-grants",
    {
      schema: {
        operationId: RouteId.GetAppaGithubAppGrants,
        description:
          "The GitHub App's permissions against what self-service needs, with the pages that grant them",
        tags: ["OpenAPPA"],
        response: constructResponseSchema(AppaGithubAppGrantsSchema.nullable()),
      },
    },
    async (request, reply) =>
      reply.send(
        (await getAppaGithubAppGrants(request.organizationId)) ?? null,
      ),
  );
  app.get(
    "/api/openappa/github-sync/self-service",
    {
      schema: {
        operationId: RouteId.GetAppaSelfService,
        description:
          "Whether MCP server editors change their servers' Guardrails rules themselves, through pull requests on the policy repository",
        tags: ["OpenAPPA"],
        response: constructResponseSchema(AppaSelfServiceAvailabilitySchema),
      },
    },
    async (request, reply) =>
      reply.send(await getAppaSelfService(request.organizationId)),
  );
  app.put(
    "/api/openappa/github-sync",
    {
      schema: {
        operationId: RouteId.ConfigureAppaGithubSync,
        tags: ["OpenAPPA"],
        body: AppaGithubSourceSchema,
        response: constructResponseSchema(AppaGithubSyncStatusSchema),
      },
    },
    async (request, reply) => {
      const status = await configureAppaGithubSync({
        organizationId: request.organizationId,
        userId: request.user.id,
        source: request.body,
      });
      return reply.send(await withServersIncluded(request, status));
    },
  );
  app.post(
    "/api/openappa/github-sync/repository",
    {
      schema: {
        operationId: RouteId.CreateAppaGithubRepository,
        tags: ["OpenAPPA"],
        body: CreateAppaGithubRepositorySchema,
        response: constructResponseSchema(AppaGithubSyncStatusSchema),
      },
    },
    async (request, reply) => {
      const status = await createAppaGithubRepository({
        organizationId: request.organizationId,
        userId: request.user.id,
        ...request.body,
      });
      return reply.send(await withServersIncluded(request, status));
    },
  );
  app.post(
    "/api/openappa/github-app/manifest",
    {
      schema: {
        operationId: RouteId.StartAppaGithubApp,
        description:
          "Start registering the OpenAPPA GitHub App, from a manifest, on the account that owns the policy repository",
        tags: ["OpenAPPA"],
        body: StartAppaGithubAppSchema,
        response: constructResponseSchema(AppaGithubAppManifestSchema),
      },
    },
    async (request, reply) => {
      request.auditSkip = true;
      return reply.send(
        await openappaGithubAppSetup.start({
          organizationId: request.organizationId,
          userId: request.user.id,
          ...request.body,
        }),
      );
    },
  );
  app.post(
    "/api/openappa/github-app/manifest/complete",
    {
      schema: {
        operationId: RouteId.CompleteAppaGithubApp,
        description:
          "Exchange GitHub's one-time code for the new App; it is stored once installed",
        tags: ["OpenAPPA"],
        body: CompleteAppaGithubAppSchema,
        response: constructResponseSchema(PendingAppaGithubAppSchema),
      },
    },
    async (request, reply) => {
      request.auditSkip = true;
      return reply.send(
        await openappaGithubAppSetup.complete({
          organizationId: request.organizationId,
          userId: request.user.id,
          ...request.body,
        }),
      );
    },
  );
  app.get(
    "/api/openappa/github-app/pending",
    {
      schema: {
        operationId: RouteId.GetPendingAppaGithubApp,
        description:
          "The GitHub App created during setup that is not installed yet",
        tags: ["OpenAPPA"],
        response: constructResponseSchema(
          PendingAppaGithubAppSchema.nullable(),
        ),
      },
    },
    async (request, reply) =>
      reply.send(
        await openappaGithubAppSetup.pending({
          organizationId: request.organizationId,
          userId: request.user.id,
        }),
      ),
  );
  app.delete(
    "/api/openappa/github-app/pending",
    {
      schema: {
        operationId: RouteId.DiscardAppaGithubApp,
        description:
          "Forget the GitHub App created during setup so setup can start over",
        tags: ["OpenAPPA"],
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async (request, reply) => {
      // Only a short-lived setup record is dropped; nothing durable changes.
      request.auditSkip = true;
      await openappaGithubAppSetup.discard({
        organizationId: request.organizationId,
        userId: request.user.id,
      });
      return reply.send({ success: true });
    },
  );
  app.post(
    "/api/openappa/github-app/install",
    {
      schema: {
        operationId: RouteId.InstallAppaGithubApp,
        description:
          "Store the new GitHub App as an organization credential once it is installed",
        tags: ["OpenAPPA"],
        response: constructResponseSchema(AppaGithubAppInstallResultSchema),
      },
    },
    async (request, reply) => {
      const result = await openappaGithubAppSetup.install({
        organizationId: request.organizationId,
        userId: request.user.id,
      });
      if (result.status === "waiting") request.auditSkip = true;
      else request.auditBefore = null;
      return reply.send(result);
    },
  );
  app.get(
    "/api/openappa/github-app/repository",
    {
      schema: {
        operationId: RouteId.GetAppaGithubRepositoryStatus,
        description:
          "Whether a policy repository already exists, as far as the organization's GitHub Apps can see",
        tags: ["OpenAPPA"],
        querystring: AppaGithubRepositoryQuerySchema,
        response: constructResponseSchema(AppaGithubRepositoryStatusSchema),
      },
    },
    async (request, reply) =>
      reply.send(
        await openappaGithubAppSetup.repository({
          organizationId: request.organizationId,
          ...request.query,
        }),
      ),
  );
  app.get(
    "/api/openappa/github-app/accounts",
    {
      schema: {
        operationId: RouteId.GetAppaGithubAppAccounts,
        description:
          "The GitHub account each organization GitHub App is installed on",
        tags: ["OpenAPPA"],
        response: constructResponseSchema(AppaGithubAppAccountsSchema),
      },
    },
    async (request, reply) =>
      reply.send(await openappaGithubAppSetup.accounts(request.organizationId)),
  );
  app.get(
    "/api/openappa/github-app/repositories",
    {
      schema: {
        operationId: RouteId.GetAppaGithubAppRepositories,
        description:
          "The repositories an organization GitHub App can reach, recent template copies first",
        tags: ["OpenAPPA"],
        querystring: AppaGithubAppRepositoriesQuerySchema,
        response: constructResponseSchema(AppaGithubAppRepositoriesSchema),
      },
    },
    async (request, reply) =>
      reply.send(
        await openappaGithubAppSetup.repositories({
          organizationId: request.organizationId,
          credentialId: request.query.credentialId,
        }),
      ),
  );
  app.patch(
    "/api/openappa/github-sync",
    {
      schema: {
        operationId: RouteId.UpdateAppaGithubSync,
        tags: ["OpenAPPA"],
        body: AppaGithubSyncActionSchema,
        response: constructResponseSchema(AppaGithubSyncStatusSchema),
      },
    },
    async (request, reply) => {
      if (request.body.action === "sync") {
        request.auditBefore = { syncRequested: false };
        request.auditAfter = { syncRequested: true };
      }
      if (request.body.action === "include_servers") {
        await ensureSelfServiceInclude({
          organizationId: request.organizationId,
          userId: request.user.id,
        });
        return reply.send(await getAppaGithubSync(request.organizationId));
      }
      // The switch's dialog opens the pull request that includes the
      // servers' folder as its own step, with include_servers.
      return reply.send(
        await updateAppaGithubSync({
          organizationId: request.organizationId,
          ...request.body,
        }),
      );
    },
  );
};
export default routes;

/**
 * After a source change or a switch that turned self-service on: open the
 * pull request that includes the servers' folder when the policy file lacks
 * it, in the caller's name. A pull request that cannot open does not undo
 * what was saved; the Git sync card offers it again.
 */
async function withServersIncluded<
  T extends { selfService: { enabled: boolean }; source: unknown },
>(request: { organizationId: string; user: { id: string } }, status: T) {
  // Release 1.4: the flag is the deployment's; only a GitHub App source
  // gets the check and the include pull request.
  if (
    !status.selfService.enabled ||
    !(await selfServiceInForce(request.organizationId))
  )
    return status;
  try {
    const opened = await ensureSelfServiceInclude({
      organizationId: request.organizationId,
      userId: request.user.id,
    });
    if (!opened) return status;
  } catch (error) {
    logger.warn(
      { organizationId: request.organizationId, error },
      "OpenAPPA could not open the pull request that includes the self-service folder",
    );
    return status;
  }
  return getAppaGithubSync(request.organizationId);
}
