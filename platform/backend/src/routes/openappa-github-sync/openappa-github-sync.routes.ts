import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { openappaGithubAppSetup } from "@/services/openappa-github-app-setup";
import {
  acceptHeldAppaGithubPull,
  configureAppaGithubSync,
  createAppaGithubRepository,
  getAppaGithubSync,
  updateAppaGithubSync,
} from "@/services/openappa-github-sync";
import { constructResponseSchema, DeleteObjectResponseSchema } from "@/types";
import {
  AppaGithubAppAccountsSchema,
  AppaGithubAppInstallResultSchema,
  AppaGithubAppManifestSchema,
  CompleteAppaGithubAppSchema,
  PendingAppaGithubAppSchema,
  StartAppaGithubAppSchema,
} from "@/types/openappa-github-app-setup";
import {
  AcceptedHeldPullSchema,
  AppaGithubSourceSchema,
  AppaGithubSyncActionSchema,
  AppaGithubSyncStatusSchema,
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
    async (request, reply) =>
      reply.send(
        await configureAppaGithubSync({
          organizationId: request.organizationId,
          userId: request.user.id,
          source: request.body,
        }),
      ),
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
    async (request, reply) =>
      reply.send(
        await createAppaGithubRepository({
          organizationId: request.organizationId,
          userId: request.user.id,
          ...request.body,
        }),
      ),
  );
  app.post(
    "/api/openappa/github-app/manifest",
    {
      schema: {
        operationId: RouteId.StartAppaGithubApp,
        description:
          "Start registering the OpenAPPA GitHub App on an organization from a manifest",
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
          organization: request.body.organization,
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
      return reply.send(
        await updateAppaGithubSync({
          organizationId: request.organizationId,
          ...request.body,
        }),
      );
    },
  );
  app.post(
    "/api/openappa/github-sync/accept-held",
    {
      schema: {
        operationId: RouteId.AcceptHeldAppaGithubPull,
        tags: ["OpenAPPA"],
        response: constructResponseSchema(AcceptedHeldPullSchema),
      },
    },
    async (request, reply) => {
      const { accepted, status } = await acceptHeldAppaGithubPull({
        organizationId: request.organizationId,
        userId: request.user.id,
      });
      // What the repository's text changes that it could not authorize itself
      // belongs in the audit record, named, not only in the sync row.
      request.auditBefore = { heldPull: accepted.sourceCommit };
      request.auditAfter = {
        acceptedPull: accepted.sourceCommit,
        contentHash: accepted.contentHash,
        reasons: accepted.reasons,
        droppedBatteries: accepted.droppedBatteries,
        changedVariables: accepted.changedVariables,
      };
      return reply.send({ ...accepted, status });
    },
  );
};
export default routes;
