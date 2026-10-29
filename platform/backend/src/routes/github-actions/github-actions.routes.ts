import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import config from "@/config";
import logger from "@/logging";
import { GITHUB_ACTIONS_TOKEN_PATH } from "@/routes/route-paths";
import { exchangeGitHubActionsToken } from "@/services/github-actions-access";
import { githubActionsTokenRateLimiter } from "@/services/oauth-token-rate-limit";
import {
  GitHubActionsTokenErrorSchema,
  GitHubActionsTokenRequestSchema,
  GitHubActionsTokenResponseSchema,
} from "@/types/github-actions-token";

/**
 * Token exchange for GitHub Actions pull-request jobs. Public: the OIDC token
 * in the body is the only credential. Like an OAuth token endpoint, every
 * answer is `{ error, message }` with a stable code a workflow can branch on.
 */
const githubActionsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    GITHUB_ACTIONS_TOKEN_PATH,
    {
      // A malformed body is answered in the same `{ error, message }` shape.
      attachValidation: true,
      schema: {
        operationId: RouteId.ExchangeGitHubActionsToken,
        description:
          "Trade a GitHub Actions OIDC token from a pull_request workflow run for an MCP gateway token, plus a GitHub App installation token for that repository. The gateway token acts as the pull request's author, for runs the author started, or, when the gateway's GitHub Actions setting has actAs \"actor\", as whoever started the run. The gateway must allow the repository and workflow, and that person must have connected GitHub through the gateway's GitHub App.",
        tags: ["GitHub Actions"],
        body: GitHubActionsTokenRequestSchema,
        response: {
          200: GitHubActionsTokenResponseSchema,
          400: GitHubActionsTokenErrorSchema,
          401: GitHubActionsTokenErrorSchema,
          403: GitHubActionsTokenErrorSchema,
          429: GitHubActionsTokenErrorSchema,
          500: GitHubActionsTokenErrorSchema,
          502: GitHubActionsTokenErrorSchema,
        },
      },
      async onRequest(request, reply) {
        if (config.authRateLimitDisabled) return;
        const limit = await githubActionsTokenRateLimiter.consume(request.ip);
        if (limit.allowed) return;
        return reply
          .header("Retry-After", limit.retryAfter)
          .header("Cache-Control", "no-store")
          .code(429)
          .send({
            error: "rate_limited",
            message:
              "Too many token requests. Retry after the indicated delay.",
          });
      },
    },
    // codeql[js/missing-rate-limiting] The onRequest hook enforces a distributed, atomic IP budget before this handler; CodeQL only models package-based middleware.
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (request.validationError)
        return reply.code(400).send({
          error: "invalid_request",
          message: "The body must be JSON with a token and a resource.",
        });

      let result: Awaited<ReturnType<typeof exchangeGitHubActionsToken>>;
      try {
        result = await exchangeGitHubActionsToken(request.body);
      } catch (error) {
        logger.error(
          {
            resource: request.body.resource,
            errorClass: error instanceof Error ? error.name : typeof error,
            error: error instanceof Error ? error.message : String(error),
          },
          "[github-actions] Token exchange failed",
        );
        return reply.code(500).send({
          error: "server_error",
          message:
            "The token exchange failed. Request a new OIDC token and try again.",
        });
      }
      if (result.ok) return reply.send(result.body);

      logger.info(
        {
          resource: request.body.resource,
          error: result.body.error,
          githubLogin: result.body.login,
        },
        "[github-actions] Refused a token exchange",
      );
      return reply.code(result.statusCode).send(result.body);
    },
  );
};

export default githubActionsRoutes;
