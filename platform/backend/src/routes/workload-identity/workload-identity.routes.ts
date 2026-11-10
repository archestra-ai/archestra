// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import config from "@/config";
import logger from "@/logging";
import { WORKLOAD_IDENTITY_TOKEN_PATH } from "@/routes/route-paths";
import { workloadIdentityTokenRateLimiter } from "@/services/oauth-token-rate-limit";
import { exchangeWorkloadIdentityToken } from "@/services/workload-identity/token-exchange";
import {
  WorkloadIdentityTokenErrorSchema,
  WorkloadIdentityTokenRequestSchema,
  WorkloadIdentityTokenResponseSchema,
} from "@/types/service-account-federated-credential";

/**
 * RFC 8693 token exchange for workload identity federation. Public: the OIDC
 * token in the body is the only credential. Like an OAuth token endpoint,
 * every answer is `{ error, error_description }` with an RFC 6749 code, and
 * the body may be form-encoded or JSON.
 */
const workloadIdentityRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    WORKLOAD_IDENTITY_TOKEN_PATH,
    {
      attachValidation: true,
      schema: {
        operationId: RouteId.ExchangeWorkloadIdentityToken,
        description:
          "Exchange an OIDC token from a workload's own identity provider (GitHub Actions, GitLab CI, Kubernetes, Google) for a short-lived token that acts as a service account (RFC 8693). Send grant_type urn:ietf:params:oauth:grant-type:token-exchange, subject_token_type urn:ietf:params:oauth:token-type:jwt, the token as subject_token, and service_account_id, form-encoded or as JSON. The token must match one of the account's federated credentials exactly. The issued token expires after one hour and carries the account's roles.",
        tags: ["Service Accounts"],
        body: WorkloadIdentityTokenRequestSchema,
        response: {
          200: WorkloadIdentityTokenResponseSchema,
          400: WorkloadIdentityTokenErrorSchema,
          429: WorkloadIdentityTokenErrorSchema,
          500: WorkloadIdentityTokenErrorSchema,
        },
      },
      async onRequest(request, reply) {
        if (config.authRateLimitDisabled) return;
        const limit = await workloadIdentityTokenRateLimiter.consume(
          request.ip,
        );
        if (limit.allowed) return;
        return reply
          .header("Retry-After", limit.retryAfter)
          .header("Cache-Control", "no-store")
          .code(429)
          .send({
            error: "rate_limited",
            error_description:
              "Too many token requests. Retry after the indicated delay.",
          });
      },
    },
    // codeql[js/missing-rate-limiting] The onRequest hook enforces a distributed, atomic IP budget before this handler; CodeQL only models package-based middleware.
    async (request, reply) => {
      reply.header("Cache-Control", "no-store").header("Pragma", "no-cache");
      if (request.validationError)
        return reply.code(400).send({
          error: "invalid_request",
          error_description:
            "The body must be form-encoded or JSON token exchange parameters.",
        });

      try {
        const result = await exchangeWorkloadIdentityToken({
          body: request.body,
          request: {
            method: request.method,
            path: WORKLOAD_IDENTITY_TOKEN_PATH,
            route: request.routeOptions.url ?? null,
            requestId: request.id,
            sourceIp: request.ip || null,
            userAgent:
              (request.headers["user-agent"] as string | undefined) ?? null,
          },
        });
        if (result.ok) return reply.send(result.body);
        return reply.code(result.statusCode).send(result.body);
      } catch (error) {
        logger.error(
          {
            serviceAccountId: request.body.service_account_id,
            errorClass: error instanceof Error ? error.name : typeof error,
            error: error instanceof Error ? error.message : String(error),
          },
          "[workload-identity] Token exchange failed",
        );
        return reply.code(500).send({
          error: "server_error",
          error_description:
            "The token exchange failed. Request a new OIDC token and try again.",
        });
      }
    },
  );
};

export default workloadIdentityRoutes;
