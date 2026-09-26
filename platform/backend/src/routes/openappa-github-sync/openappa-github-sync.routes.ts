import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { userHasPermission } from "@/auth";
import {
  acceptHeldAppaGithubPull,
  configureAppaGithubSync,
  createAppaGithubRepository,
  getAppaGithubSync,
  updateAppaGithubSync,
} from "@/services/openappa-github-sync";
import { ApiError, constructResponseSchema } from "@/types";
import {
  AcceptedHeldPullSchema,
  AppaGithubSourceSchema,
  AppaGithubSyncActionSchema,
  AppaGithubSyncStatusSchema,
  CreateAppaGithubRepositorySchema,
} from "@/types/openappa-github-sync";

const routes: FastifyPluginAsyncZod = async (app) => {
  // This changes organization policy, so require organization management as well as the endpoint permission.
  app.addHook("preHandler", async (request) => {
    if (
      request.method !== "GET" &&
      !(await userHasPermission(
        request.user.id,
        request.organizationId,
        "organization",
        "update",
      ))
    )
      throw new ApiError(
        403,
        "Organization update permission is required to manage APPA sync",
      );
  });
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
