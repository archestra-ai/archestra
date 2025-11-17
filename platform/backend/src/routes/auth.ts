import { DEFAULT_ADMIN_EMAIL, PermissionsSchema, RouteId } from "@shared";
import { verifyPassword } from "better-auth/crypto";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { betterAuth } from "@/auth";
import { hasPermission } from "@/auth/utils";
import config from "@/config";
import { AccountModel, UserModel } from "@/models";
import { ApiError, constructResponseSchema } from "@/types";

const HasPermissionsResponseSchema = z.object({
  success: z.boolean(),
});

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

      const req = new Request(url.toString(), {
        method: request.method,
        headers,
        body: request.body ? JSON.stringify(request.body) : undefined,
      });

      const response = await betterAuth.handler(req);

      reply.status(response.status);

      response.headers.forEach((value, key) => {
        reply.header(key, value);
      });

      reply.send(response.body ? await response.text() : null);
    },
  });

  /**
   * NOTE: the following two endpoints are a 💩 hack to get around a bug in better-auth's
   * usage of dynamic access control within the organization plugin
   *
   * See https://github.com/better-auth/better-auth/issues/5860
   */
  fastify.post(
    "/api/auth/organization/has-permission",
    {
      schema: {
        body: z.object({
          organizationId: z.string(),
          /**
           * NOTE: for some reason, some better-auth-ui components are (internally)
           * calling POST /api/auth/organization/has-permission with permission in the
           * request body, while other requests are using permissions...
           */
          permissions: PermissionsSchema.optional(),
          permission: PermissionsSchema.optional(),
        }),
        response: constructResponseSchema(HasPermissionsResponseSchema),
      },
    },
    async ({ body: { permissions, permission }, headers }, reply) => {
      if (!permissions && !permission) {
        throw new ApiError(400, "Missing permissions or permission");
      }

      const { success } = await hasPermission(
        permission || permissions || {},
        headers,
      );
      return reply.send({ success });
    },
  );

  fastify.post(
    "/api/auth/has-permission",
    {
      schema: {
        operationId: RouteId.HasPermission,
        description: "Check if current user has required permissions",
        tags: ["auth"],
        body: z.object({
          permissions: PermissionsSchema,
        }),
        response: constructResponseSchema(HasPermissionsResponseSchema),
      },
    },
    async ({ body: { permissions }, headers }, reply) => {
      const { success } = await hasPermission(permissions, headers);
      return reply.send({ success });
    },
  );
};

export default authRoutes;
