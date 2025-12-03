import { DEFAULT_ADMIN_EMAIL, RouteId } from "@shared";
import { verifyPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { betterAuth } from "@/auth";
import config from "@/config";
import db, { schema } from "@/database";
import logger from "@/logging";
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
        const memberToDelete = await db
          .select()
          .from(schema.membersTable)
          .where(eq(schema.membersTable.id, memberIdOrEmail))
          .limit(1)
          .then((rows) => rows[0]);

        if (memberToDelete) {
          userId = memberToDelete.userId;
        } else {
          // Maybe it's an email - try finding by userId + orgId
          const memberByUserId = await db
            .select()
            .from(schema.membersTable)
            .where(
              and(
                eq(schema.membersTable.userId, memberIdOrEmail),
                eq(schema.membersTable.organizationId, organizationId),
              ),
            )
            .limit(1)
            .then((rows) => rows[0]);

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

      // After successful member removal, check if user should be deleted
      if (response.ok && userId) {
        try {
          const remainingMembers = await db
            .select()
            .from(schema.membersTable)
            .where(eq(schema.membersTable.userId, userId))
            .limit(1);

          if (remainingMembers.length === 0) {
            await db
              .delete(schema.usersTable)
              .where(eq(schema.usersTable.id, userId));
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
