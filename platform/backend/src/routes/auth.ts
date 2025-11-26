import { DEFAULT_ADMIN_EMAIL, RouteId } from "@shared";
import { verifyPassword } from "better-auth/crypto";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { betterAuth } from "@/auth";
import config from "@/config";
import { AccountModel, UserModel } from "@/models";

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

      response.headers.forEach((value: string, key: string) => {
        reply.header(key, value);
      });

      reply.send(response.body ? await response.text() : null);
    },
  });
};

export default authRoutes;
