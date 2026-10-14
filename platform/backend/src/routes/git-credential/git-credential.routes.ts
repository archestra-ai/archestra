import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { gitClient, resolveGitCredentialAccess } from "@/git-hosts/git-access";
import { GitHostError } from "@/git-hosts/git-host-client";
import {
  createGitlabToken,
  listGitCredentials,
} from "@/services/git-credentials";
import { openappaGithubAppSetup } from "@/services/openappa-github-app-setup";
import {
  ApiError,
  CreateGitlabTokenRequestSchema,
  constructResponseSchema,
  GitCredentialSchema,
  GitRepositorySummarySchema,
  UuidIdSchema,
} from "@/types";

/**
 * Credentials that read repositories for skills, plugins, and guardrails
 * policies: GitHub Apps (created through GitHub) and GitLab access tokens.
 */
const gitCredentialRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/git-credentials",
    {
      schema: {
        operationId: RouteId.ListGitCredentials,
        description:
          "List the organization's GitHub Apps and GitLab access tokens. Token values are never returned.",
        tags: ["Git credentials"],
        response: constructResponseSchema(z.array(GitCredentialSchema)),
      },
    },
    async ({ organizationId }, reply) =>
      reply.send(await listGitCredentials(organizationId)),
  );

  fastify.post(
    "/api/git-credentials/gitlab",
    {
      schema: {
        operationId: RouteId.CreateGitlabToken,
        description:
          "Save a GitLab access token after GitLab confirms it can read the API. The token is stored as a secret and never returned.",
        tags: ["Git credentials"],
        body: CreateGitlabTokenRequestSchema,
        response: constructResponseSchema(GitCredentialSchema),
      },
    },
    async ({ organizationId, body, user }, reply) =>
      reply.send(
        await createGitlabToken({
          organizationId,
          userId: user.id,
          data: body,
        }),
      ),
  );

  fastify.get(
    "/api/git-credentials/:id/repositories",
    {
      schema: {
        operationId: RouteId.ListGitCredentialRepositories,
        description:
          "Repositories a Git credential can reach: the GitHub App's installed repositories, or the GitLab projects the token is a member of.",
        tags: ["Git credentials"],
        params: z.object({ id: UuidIdSchema }),
        querystring: z.object({
          search: z.string().trim().max(200).optional(),
        }),
        response: constructResponseSchema(z.array(GitRepositorySummarySchema)),
      },
    },
    async ({ organizationId, params, query }, reply) => {
      const access = await resolveGitCredentialAccess({
        organizationId,
        credentialId: params.id,
      });
      try {
        return reply.send(
          await gitClient(access).listRepositories(query.search),
        );
      } catch (error) {
        if (error instanceof GitHostError)
          throw new ApiError(502, error.message);
        throw error;
      }
    },
  );

  fastify.get(
    "/api/git-credentials/:id/namespaces",
    {
      schema: {
        operationId: RouteId.ListGitCredentialNamespaces,
        description:
          "Where a Git credential can create repositories: the GitHub App's account, or the GitLab groups the token can create projects in. An empty string is the GitLab token owner's own namespace.",
        tags: ["Git credentials"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(z.array(z.string())),
      },
    },
    async ({ organizationId, params }, reply) => {
      const access = await resolveGitCredentialAccess({
        organizationId,
        credentialId: params.id,
      });
      if (access.host.provider === "github") {
        const accounts = await openappaGithubAppSetup.accounts(organizationId);
        const account = accounts.find((entry) => entry.id === params.id);
        return reply.send(account?.account ? [account.account] : []);
      }
      try {
        const groups = await gitClient(access).gitlabNamespaces();
        return reply.send(["", ...groups.map((group) => group.fullPath)]);
      } catch (error) {
        if (error instanceof GitHostError)
          throw new ApiError(502, error.message);
        throw error;
      }
    },
  );
};

export default gitCredentialRoutes;
