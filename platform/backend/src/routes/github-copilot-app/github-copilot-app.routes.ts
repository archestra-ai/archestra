import { RouteId } from "@archestra/shared";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { sanitizeAuditSnapshot } from "@/middleware/audit-log-hook";
import { LlmProviderApiKeyModel } from "@/models";
import { copilotGithubAppSetup } from "@/services/github-copilot-app-setup";
import { constructResponseSchema, DeleteObjectResponseSchema } from "@/types";
import {
  CompleteGithubAppSchema,
  GithubAppManifestSchema,
  PendingGithubAppSchema,
} from "@/types/github-app-manifest-setup";
import {
  CheckCopilotGithubOrganizationSchema,
  ConnectCopilotGithubAppCredentialResultSchema,
  ConnectCopilotGithubAppCredentialSchema,
  ConnectExistingCopilotGithubAppSchema,
  CopilotGithubAppConnectedSchema,
  CopilotGithubAppInstallResultSchema,
  CopilotGithubAppKeySummarySchema,
  CopilotGithubOrganizationSchema,
  ExistingCopilotGithubAppValidationSchema,
  InstallCopilotGithubAppSchema,
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
        response: constructResponseSchema(GithubAppManifestSchema),
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
        body: CompleteGithubAppSchema,
        response: constructResponseSchema(PendingGithubAppSchema),
      },
    },
    async (request, reply) => {
      // Only a short-lived setup record changes; the stored credential is
      // audited when installation completes.
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
        response: constructResponseSchema(PendingGithubAppSchema.nullable()),
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
      await auditKeyReconnect(request);
      const result = await copilotGithubAppSetup.install({
        organizationId: request.organizationId,
        userId: request.user.id,
        grants: request.body.grants,
        replaceKeyId: request.body.replaceKeyId,
        name: request.body.name,
      });
      if (result.status === "waiting") request.auditSkip = true;
      else if (!request.body.replaceKeyId) request.auditBefore = null;
      return reply.send(result);
    },
  );
  app.post(
    "/api/github-copilot-app/credential",
    {
      schema: {
        operationId: RouteId.ConnectCopilotGithubAppCredential,
        description:
          "Use a GitHub App the organization already connected. Says so when its installation lacks Copilot Requests",
        tags: ["LLM Provider API Keys"],
        body: ConnectCopilotGithubAppCredentialSchema,
        response: constructResponseSchema(
          ConnectCopilotGithubAppCredentialResultSchema,
        ),
      },
    },
    async (request, reply) => {
      await auditKeyReconnect(request);
      const result = await copilotGithubAppSetup.connectFromCredential({
        organizationId: request.organizationId,
        userId: request.user.id,
        ...request.body,
      });
      if (result.status !== "installed") request.auditSkip = true;
      else if (!request.body.replaceKeyId) request.auditBefore = null;
      return reply.send(result);
    },
  );
  app.post(
    "/api/github-copilot-app/organization/check",
    {
      schema: {
        operationId: RouteId.CheckCopilotGithubOrganization,
        description:
          "Check that a name or GitHub address names a GitHub organization, before connecting an existing App",
        tags: ["LLM Provider API Keys"],
        body: CheckCopilotGithubOrganizationSchema,
        response: constructResponseSchema(CopilotGithubOrganizationSchema),
      },
    },
    async (request, reply) => {
      // Reads GitHub only; nothing is stored.
      request.auditSkip = true;
      return reply.send(
        await copilotGithubAppSetup.checkOrganization({
          organizationId: request.organizationId,
          userId: request.user.id,
          ...request.body,
        }),
      );
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
        await copilotGithubAppSetup.validateExisting({
          organizationId: request.organizationId,
          userId: request.user.id,
          ...request.body,
        });
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
      await auditKeyReconnect(request);
      const result = await copilotGithubAppSetup.connectByKey({
        organizationId: request.organizationId,
        userId: request.user.id,
        ...request.body,
      });
      if (!request.body.replaceKeyId) request.auditBefore = null;
      return reply.send(result);
    },
  );
  app.get(
    "/api/github-copilot-app/keys/:id",
    {
      schema: {
        operationId: RouteId.GetCopilotGithubAppKeySummary,
        description:
          "The organization, App (name, icon, GitHub page) and key fingerprint of an organization's GitHub Copilot subscription",
        tags: ["LLM Provider API Keys"],
        params: z.object({ id: z.string().uuid() }),
        response: constructResponseSchema(CopilotGithubAppKeySummarySchema),
      },
    },
    async (request, reply) =>
      reply.send(
        await copilotGithubAppSetup.summary({
          organizationId: request.organizationId,
          userId: request.user.id,
          keyId: request.params.id,
        }),
      ),
  );
};

export default githubCopilotAppRoutes;

/**
 * Reconnecting a plan (`replaceKeyId`) updates that key: audited as an
 * update, with the key as it was before.
 */
async function auditKeyReconnect(request: FastifyRequest) {
  const { replaceKeyId } = request.body as { replaceKeyId?: string };
  if (!replaceKeyId) return;
  request.auditAction = "llmProviderApiKey.updated";
  request.auditBefore = sanitizeAuditSnapshot(
    await LlmProviderApiKeyModel.findByIdForAudit(
      replaceKeyId,
      request.organizationId,
    ),
  );
}
