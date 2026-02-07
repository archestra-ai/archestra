import { DEFAULT_ADMIN_EMAIL, RouteId } from "@shared";
import { verifyPassword } from "better-auth/crypto";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { betterAuth } from "@/auth";
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

  // OAuth 2.1 Consent — intercept better-auth redirect and return JSON
  // Browser fetch with redirect:"manual" produces opaque redirect responses
  // where Location header is inaccessible. Convert redirect to JSON so the
  // consent form can read the URL and navigate.
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

  // OAuth 2.1 Dynamic Client Registration
  // MCP clients are public OAuth clients (RFC 8252) but may not send
  // token_endpoint_auth_method. Default to "none" so better-auth allows
  // unauthenticated registration for these clients.
  fastify.route({
    method: "POST",
    url: "/api/auth/oauth2/register",
    schema: {
      tags: ["auth"],
    },
    async handler(request, reply) {
      const body = (request.body as Record<string, unknown> | undefined) ?? {};
      // Force public client for unauthenticated DCR (MCP spec requires PKCE,
      // not client_secret). Open WebUI may send client_secret_post but MCP
      // clients must be public for unauthenticated registration to work.
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

      reply.status(response.status);

      response.headers.forEach((value: string, key: string) => {
        reply.header(key, value);
      });

      reply.send(response.body ? await response.text() : null);
    },
  });
};

export default authRoutes;
