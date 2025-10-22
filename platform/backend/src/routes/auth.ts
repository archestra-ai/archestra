import { DEFAULT_ADMIN_EMAIL } from "@shared";
import { verifyPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { auth } from "@/auth/auth";
import config from "@/config";
import db, { schema } from "@/database";
import { RouteId } from "@/types";

// Register authentication endpoints
const authRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // Check if default credentials are enabled
  fastify.route({
    method: "GET",
    url: "/api/auth/default-credentials-status",
    schema: {
      operationId: RouteId.GetDefaultCredentialsStatus,
      description: "Get default credentials status",
      tags: ["Auth"],
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
        // Check if admin email from config matches the default
        const configUsesDefaults =
          config.auth.adminDefaultEmail === DEFAULT_ADMIN_EMAIL;

        if (!configUsesDefaults) {
          // Custom credentials are configured
          return reply.send({ enabled: false });
        }

        // Check if a user with the default email exists
        const [adminUser] = await db
          .select()
          .from(schema.usersTable)
          .where(eq(schema.usersTable.email, DEFAULT_ADMIN_EMAIL))
          .limit(1);

        if (!adminUser) {
          // Default admin user doesn't exist
          return reply.send({ enabled: false });
        }

        // Check if the user is using the default password
        // Get the password hash from the account table
        const [account] = await db
          .select()
          .from(schema.account)
          .where(eq(schema.account.userId, adminUser.id))
          .limit(1);

        if (!account?.password) {
          // No password set (shouldn't happen for email/password auth)
          return reply.send({ enabled: false });
        }

        // Compare the stored password hash with the default password
        const isDefaultPassword = await verifyPassword({
          password: config.auth.adminDefaultPassword,
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
    async handler(request, reply) {
      try {
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
        const response = await auth.handler(req);
        reply.status(response.status);
        response.headers.forEach((value, key) => {
          reply.header(key, value);
        });
        reply.send(response.body ? await response.text() : null);
      } catch (error) {
        fastify.log.error(error);
        reply.status(500).send({
          error: "Internal authentication error",
          code: "AUTH_FAILURE",
        });
      }
    },
  });
};

export default authRoutes;
