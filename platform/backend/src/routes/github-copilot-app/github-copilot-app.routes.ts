import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { copilotGithubAppSetup } from "@/services/github-copilot-app-setup";
import { constructResponseSchema, DeleteObjectResponseSchema } from "@/types";
import {
  CompleteCopilotGithubAppSchema,
  ConnectExistingCopilotGithubAppSchema,
  CopilotGithubAppConnectedSchema,
  CopilotGithubAppInstallResultSchema,
  CopilotGithubAppManifestSchema,
  ExistingCopilotGithubAppValidationSchema,
  InstallCopilotGithubAppSchema,
  PendingCopilotGithubAppSchema,
  StartCopilotGithubAppSchema,
  ValidateExistingCopilotGithubAppSchema,
} from "@/types/github-copilot-app-setup";

/**
 * GitHub Copilot paid by a GitHub organization: registers or takes a GitHub
 * App and stores it as a shared `github-copilot` provider key.
 */
const githubCopilotAppRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/api/github-copilot-app/manifest",
    {
      schema: {
        operationId: RouteId.StartCopilotGithubApp,
        description:
          "Start registering a GitHub App, from a manifest, that makes Copilot requests for a GitHub organization",
        tags: ["LLM Provider API Keys"],
        body: StartCopilotGithubAppSchema,
        response: constructResponseSchema(CopilotGithubAppManifestSchema),
      },
    },
    async (request, reply) => {
      // Only GitHub and a short-lived setup record are touched.
      request.auditSkip = true;
      return reply.send(
        await copilotGithubAppSetup.start({
          organizationId: request.organizationId,
          userId: request.user.id,
          ...request.body,
        }),
      );
    },
  );
  app.post(
    "/api/github-copilot-app/manifest/complete",
    {
      schema: {
        operationId: RouteId.CompleteCopilotGithubApp,
        description:
          "Exchange GitHub's one-time code for the new App; it is stored once installed",
        tags: ["LLM Provider API Keys"],
        body: CompleteCopilotGithubAppSchema,
        response: constructResponseSchema(PendingCopilotGithubAppSchema),
      },
    },
    async (request, reply) => {
      request.auditSkip = true;
      return reply.send(
        await copilotGithubAppSetup.complete({
          organizationId: request.organizationId,
          userId: request.user.id,
          ...request.body,
        }),
      );
    },
  );
  app.get(
    "/api/github-copilot-app/pending",
    {
      schema: {
        operationId: RouteId.GetPendingCopilotGithubApp,
        description:
          "The Copilot GitHub App created during setup that is not installed yet",
        tags: ["LLM Provider API Keys"],
        response: constructResponseSchema(
          PendingCopilotGithubAppSchema.nullable(),
        ),
      },
    },
    async (request, reply) =>
      reply.send(
        await copilotGithubAppSetup.pending({
          organizationId: request.organizationId,
          userId: request.user.id,
        }),
      ),
  );
  app.delete(
    "/api/github-copilot-app/pending",
    {
      schema: {
        operationId: RouteId.DiscardCopilotGithubApp,
        description:
          "Forget the Copilot GitHub App created during setup so setup can start over",
        tags: ["LLM Provider API Keys"],
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async (request, reply) => {
      request.auditSkip = true;
      await copilotGithubAppSetup.discard({
        organizationId: request.organizationId,
        userId: request.user.id,
      });
      return reply.send({ success: true });
    },
  );
  app.post(
    "/api/github-copilot-app/install",
    {
      schema: {
        operationId: RouteId.InstallCopilotGithubApp,
        description:
          "Store the new App as a shared GitHub Copilot key once it is installed on the organization",
        tags: ["LLM Provider API Keys"],
        body: InstallCopilotGithubAppSchema,
        response: constructResponseSchema(CopilotGithubAppInstallResultSchema),
      },
    },
    async (request, reply) => {
      const result = await copilotGithubAppSetup.install({
        organizationId: request.organizationId,
        userId: request.user.id,
        grants: request.body.grants,
      });
      if (result.status === "waiting") request.auditSkip = true;
      else request.auditBefore = null;
      return reply.send(result);
    },
  );
  app.post(
    "/api/github-copilot-app/existing/validate",
    {
      schema: {
        operationId: RouteId.ValidateExistingCopilotGithubApp,
        description:
          "Check an existing GitHub App and its installation on the organization; returns the private key's fingerprint",
        tags: ["LLM Provider API Keys"],
        body: ValidateExistingCopilotGithubAppSchema,
        response: constructResponseSchema(
          ExistingCopilotGithubAppValidationSchema,
        ),
      },
    },
    async (request, reply) => {
      request.auditSkip = true;
      const { fingerprint, installationId, organization } =
        await copilotGithubAppSetup.validateExisting(request.body);
      return reply.send({ fingerprint, installationId, organization });
    },
  );
  app.post(
    "/api/github-copilot-app/existing",
    {
      schema: {
        operationId: RouteId.ConnectExistingCopilotGithubApp,
        description:
          "Store an existing GitHub App as a shared GitHub Copilot key, or replace the App credentials of one",
        tags: ["LLM Provider API Keys"],
        body: ConnectExistingCopilotGithubAppSchema,
        response: constructResponseSchema(CopilotGithubAppConnectedSchema),
      },
    },
    async (request, reply) => {
      const result = await copilotGithubAppSetup.connectExisting({
        organizationId: request.organizationId,
        userId: request.user.id,
        ...request.body,
      });
      if (!request.body.replaceKeyId) request.auditBefore = null;
      return reply.send(result);
    },
  );
};

export default githubCopilotAppRoutes;
