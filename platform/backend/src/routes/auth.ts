import { DEFAULT_ADMIN_EMAIL, RouteId } from "@shared";
import { verifyPassword } from "better-auth/crypto";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { betterAuth } from "@/auth";
import { ensureCimdClientRegistered, isCimdClientId } from "@/auth/cimd";
import config from "@/config";
import logger from "@/logging";
import {
  AccountModel,
  MemberModel,
  OAuthClientModel,
  UserModel,
  UserTokenModel,
} from "@/models";

const authRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    method: "GET",
    url: "/api/auth/default-credentials-status",
    schema: {
      operationId: RouteId.GetDefaultCredentialsStatus,
      description: "Get default credentials status",
      tags: ["auth"],
      response: {
        200: z.object({
          enabled: z.boolean(),
        }),
        500: z.object({
          enabled: z.boolean(),
        }),
      },
    },
    handler: async (_request, reply) => {
      try {
        const { adminDefaultEmail, adminDefaultPassword } = config.auth;

        // Check if admin email from config matches the default
        if (adminDefaultEmail !== DEFAULT_ADMIN_EMAIL) {
          // Custom credentials are configured
          return reply.send({ enabled: false });
        }

        // Check if a user with the default email exists
        const userWithDefaultAdminEmail =
          await UserModel.getUserWithByDefaultEmail();

        if (!userWithDefaultAdminEmail) {
          // Default admin user doesn't exist
          return reply.send({ enabled: false });
        }

        /**
         * Check if the user is using the default password
         * Get the password hash from the account table
         */
        const account = await AccountModel.getByUserId(
          userWithDefaultAdminEmail.id,
        );

        if (!account?.password) {
          // No password set (shouldn't happen for email/password auth)
          return reply.send({ enabled: false });
        }

        // Compare the stored password hash with the default password
        const isDefaultPassword = await verifyPassword({
          password: adminDefaultPassword,
          hash: account.password,
        });

        return reply.send({ enabled: isDefaultPassword });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({ enabled: false });
      }
    },
  });

  // Custom handler for remove-member to delete orphaned users
  fastify.route({
    method: "POST",
    url: "/api/auth/organization/remove-member",
    schema: {
      tags: ["auth"],
    },
    async handler(request, reply) {
      const body = request.body as Record<string, unknown>;
      const memberIdOrEmail =
        (body.memberIdOrEmail as string) ||
        (body.memberIdOrUserId as string) ||
        (body.memberId as string);
      const organizationId =
        (body.organizationId as string) || (body.orgId as string);

      let userId: string | undefined;

      // Capture userId before better-auth deletes the member
      if (memberIdOrEmail) {
        // First try to find by member ID
        const memberToDelete = await MemberModel.getById(memberIdOrEmail);

        if (memberToDelete) {
          userId = memberToDelete.userId;
        } else {
          // Maybe it's an email - try finding by userId + orgId
          const memberByUserId = await MemberModel.getByUserId(
            memberIdOrEmail,
            organizationId,
          );

          if (memberByUserId) {
            userId = memberByUserId.userId;
          }
        }
      }

      // Let better-auth handle the member deletion
      const url = new URL(request.url, `http://${request.headers.host}`);
      const headers = new Headers();

      Object.entries(request.headers).forEach(([key, value]) => {
        if (value) headers.append(key, value.toString());
      });

      const req = new Request(url.toString(), {
        method: request.method,
        headers,
        body: JSON.stringify(request.body),
      });

      const response = await betterAuth.handler(req);

      // After successful member removal, delete user's personal token for this org
      if (response.ok && userId && organizationId) {
        try {
          await UserTokenModel.deleteByUserAndOrg(userId, organizationId);
          logger.info(
            `🔑 Personal token deleted for user ${userId} in org ${organizationId}`,
          );
        } catch (tokenDeleteError) {
          logger.error(
            { err: tokenDeleteError },
            "❌ Failed to delete personal token after member removal:",
          );
        }

        // Check if user should be deleted (no remaining memberships)
        try {
          const hasRemainingMemberships =
            await MemberModel.hasAnyMembership(userId);

          if (!hasRemainingMemberships) {
            await UserModel.delete(userId);
            logger.info(
              `✅ User ${userId} deleted (no remaining organizations)`,
            );
          }
        } catch (userDeleteError) {
          logger.error(
            { err: userDeleteError },
            "❌ Failed to delete user after member removal:",
          );
        }
      }

      reply.status(response.status);

      response.headers.forEach((value: string, key: string) => {
        reply.header(key, value);
      });

      reply.send(response.body ? await response.text() : null);
    },
  });

  // OAuth client info lookup (for consent page to display client name)
  fastify.route({
    method: "GET",
    url: "/api/auth/oauth2/client-info",
    schema: {
      operationId: RouteId.GetOAuthClientInfo,
      description: "Get OAuth client name by client_id",
      tags: ["auth"],
      querystring: z.object({ client_id: z.string() }),
      response: {
        200: z.object({ client_name: z.string().nullable() }),
      },
    },
    async handler(request, reply) {
      const { client_id } = request.query as { client_id: string };
      const clientName = await OAuthClientModel.getNameByClientId(client_id);
      return reply.send({ client_name: clientName });
    },
  });

  // OAuth 2.1 Authorize — intercept to auto-register CIMD clients.
  // When a URL-formatted client_id arrives, fetch the metadata document
  // and register the client before forwarding to better-auth.
  // This specific route takes priority over the catch-all GET /api/auth/*.
  fastify.route({
    method: "GET",
    url: "/api/auth/oauth2/authorize",
    schema: {
      tags: ["auth"],
    },
    async handler(request, reply) {
      const query = request.query as Record<string, string>;
      const clientId = query.client_id;

      if (clientId && isCimdClientId(clientId)) {
        try {
          await ensureCimdClientRegistered(clientId);
        } catch (error) {
          logger.warn(
            { err: error, clientId },
            "[auth:oauth2/authorize] CIMD auto-registration failed",
          );
          return reply.status(400).send({
            error: `CIMD registration failed: ${(error as Error).message}`,
          });
        }
      }

      // Forward to better-auth
      const url = new URL(request.url, `http://${request.headers.host}`);
      const headers = new Headers();
      Object.entries(request.headers).forEach(([key, value]) => {
        if (value) headers.append(key, value.toString());
      });

      const req = new Request(url.toString(), {
        method: request.method,
        headers,
      });

      const response = await betterAuth.handler(req);

      reply.status(response.status);
      response.headers.forEach((value: string, key: string) => {
        reply.header(key, value);
      });
      reply.send(response.body ? await response.text() : null);
    },
  });

  // OAuth 2.1 Token — strip the `resource` parameter before forwarding to
  // better-auth. MCP clients (e.g. Cursor, Claude Code) include `resource`
  // with dynamic per-profile URLs like `/v1/mcp/{profileId}`. better-auth's
  // `validAudiences` only supports exact-match strings so there is no way to
  // whitelist a dynamic path. Stripping `resource` causes better-auth to
  // issue opaque tokens instead of JWTs, which our MCP Gateway token
  // validator already handles.
  //
  // Also handles CIMD: if the client_id is a URL, auto-register the client
  // before forwarding to better-auth (needed for token refresh where the
  // authorize endpoint was not hit first in this server instance).
  fastify.route({
    method: "POST",
    url: "/api/auth/oauth2/token",
    schema: {
      tags: ["auth"],
    },
    async handler(request, reply) {
      const body = request.body as Record<string, unknown> | undefined;

      // CIMD: auto-register client if client_id is a URL
      const clientId = body?.client_id as string | undefined;
      if (clientId && isCimdClientId(clientId)) {
        try {
          await ensureCimdClientRegistered(clientId);
        } catch (error) {
          logger.warn(
            { err: error, clientId },
            "[auth:oauth2/token] CIMD auto-registration failed",
          );
          return reply.status(400).send({
            error: `CIMD registration failed: ${(error as Error).message}`,
          });
        }
      }

      if (body?.resource) {
        logger.debug(
          { resource: body.resource },
          "[auth:oauth2/token] Stripping resource parameter from token request",
        );
        delete body.resource;
      }

      const url = new URL(request.url, `http://${request.headers.host}`);
      const headers = new Headers();
      Object.entries(request.headers).forEach(([key, value]) => {
        if (value) headers.append(key, value.toString());
      });

      const contentType = request.headers["content-type"] || "";
      const serializedBody = contentType.includes(
        "application/x-www-form-urlencoded",
      )
        ? new URLSearchParams(body as Record<string, string>).toString()
        : JSON.stringify(body);

      const req = new Request(url.toString(), {
        method: request.method,
        headers,
        body: serializedBody,
      });

      const response = await betterAuth.handler(req);

      reply.status(response.status);
      response.headers.forEach((value: string, key: string) => {
        reply.header(key, value);
      });
      reply.send(response.body ? await response.text() : null);
    },
  });

  // OAuth 2.1 Consent — intercept better-auth redirect and return JSON
  // Browser fetch with redirect:"manual" produces opaque redirect responses
  // where Location header is inaccessible. Convert redirect to JSON so the
  // consent form can read the URL and navigate.
  //
  // CSRF protection is handled by better-auth internally:
  //   1. Origin header validation against `trustedOrigins` config
  //   2. The `oauth_query` contains a cryptographically-signed state parameter
  //      that better-auth verifies, preventing replay and tampering
  //   3. Session cookie ties consent to the authenticated user
  fastify.route({
    method: "POST",
    url: "/api/auth/oauth2/consent",
    schema: {
      operationId: RouteId.SubmitOAuthConsent,
      description: "Submit OAuth consent decision (accept or deny)",
      tags: ["auth"],
      body: z.object({
        accept: z.boolean(),
        scope: z.string(),
        oauth_query: z.string(),
      }),
      response: {
        200: z.object({ redirectTo: z.string() }),
      },
    },
    async handler(request, reply) {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const headers = new Headers();
      Object.entries(request.headers).forEach(([key, value]) => {
        if (value) headers.append(key, value.toString());
      });

      const req = new Request(url.toString(), {
        method: request.method,
        headers,
        body: JSON.stringify(request.body),
      });

      const response = await betterAuth.handler(req);

      // Forward any set-cookie headers from better-auth
      response.headers.forEach((value: string, key: string) => {
        if (key.toLowerCase() === "set-cookie") {
          reply.header(key, value);
        }
      });

      // Convert HTTP redirect to JSON so the consent form can navigate
      if (response.status === 302 || response.status === 301) {
        const location = response.headers.get("location");
        if (location) {
          return reply.send({ redirectTo: location });
        }
      }

      // better-auth may return 200 JSON with { redirect: true, uri } instead
      // of an HTTP redirect. Normalize to { redirectTo } for the frontend.
      if (response.ok && response.body) {
        const body = await response.json().catch(() => null);
        if (body?.uri) {
          return reply.send({ redirectTo: body.uri });
        }
      }

      reply.status(response.status);
      reply.send(response.body ? await response.text() : undefined);
    },
  });

  // OAuth 2.1 Dynamic Client Registration (RFC 7591)
  //
  // IMPORTANT: All dynamically registered clients are forced to public
  // (token_endpoint_auth_method = "none"), regardless of what the client
  // sends. This is intentional:
  //   - MCP OAuth spec requires PKCE, not client_secret
  //   - better-auth only allows unauthenticated DCR for public clients
  //   - Some clients (e.g. Open WebUI) send client_secret_post which would
  //     cause registration to fail without this override
  fastify.route({
    method: "POST",
    url: "/api/auth/oauth2/register",
    schema: {
      tags: ["auth"],
      body: z.record(z.string(), z.unknown()),
    },
    async handler(request, reply) {
      const body = request.body;
      // Override any client-provided value — see route comment above
      body.token_endpoint_auth_method = "none";

      const url = new URL(request.url, `http://${request.headers.host}`);
      const headers = new Headers();
      Object.entries(request.headers).forEach(([key, value]) => {
        if (value) headers.append(key, value.toString());
      });

      const req = new Request(url.toString(), {
        method: request.method,
        headers,
        body: JSON.stringify(body),
      });

      const response = await betterAuth.handler(req);

      reply.status(response.status);
      response.headers.forEach((value: string, key: string) => {
        reply.header(key, value);
      });
      reply.send(response.body ? await response.text() : null);
    },
  });

  // Existing auth handler for all other auth routes
  fastify.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    schema: {
      tags: ["auth"],
    },
    async handler(request, reply) {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const headers = new Headers();

      Object.entries(request.headers).forEach(([key, value]) => {
        if (value) headers.append(key, value.toString());
      });

      // Handle body based on content type
      // SAML callbacks use application/x-www-form-urlencoded
      let body: string | undefined;
      if (request.body) {
        const contentType = request.headers["content-type"] || "";
        if (contentType.includes("application/x-www-form-urlencoded")) {
          // Form-urlencoded body (used by SAML callbacks)
          body = new URLSearchParams(
            request.body as Record<string, string>,
          ).toString();
        } else {
          // JSON body (default)
          body = JSON.stringify(request.body);
        }
      }

      const req = new Request(url.toString(), {
        method: request.method,
        headers,
        body,
      });

      const response = await betterAuth.handler(req);

      // Check for "Invalid origin" errors and enhance with helpful guidance
      if (response.status === 403 && response.body) {
        const responseText = await response.text();
        if (responseText.includes("Invalid origin")) {
          const requestOrigin = request.headers.origin || "unknown";
          logger.warn(
            {
              origin: requestOrigin,
              trustedOrigins: config.auth.trustedOrigins,
            },
            `Origin "${requestOrigin}" is not trusted. Set ARCHESTRA_FRONTEND_URL or ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS to allow it.`,
          );

          reply.status(403);
          response.headers.forEach((value: string, key: string) => {
            reply.header(key, value);
          });
          return reply.send(
            JSON.stringify({
              message: `Invalid origin: ${requestOrigin} is not in the list of trusted origins. Set ARCHESTRA_FRONTEND_URL=${requestOrigin} or add it to ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS.`,
              trustedOrigins: config.auth.trustedOrigins,
            }),
          );
        }

        // Not an origin error — forward the already-consumed body
        reply.status(response.status);
        response.headers.forEach((value: string, key: string) => {
          reply.header(key, value);
        });
        return reply.send(responseText);
      }

      reply.status(response.status);

      response.headers.forEach((value: string, key: string) => {
        reply.header(key, value);
      });

      reply.send(response.body ? await response.text() : null);
    },
  });
};

export default authRoutes;
