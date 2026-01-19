import { DEFAULT_ADMIN_EMAIL, RouteId } from "@shared";
import { verifyPassword } from "better-auth/crypto";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { betterAuth } from "@/auth";
import config from "@/config";
import logger from "@/logging";
import { AccountModel, MemberModel, UserModel, UserTokenModel } from "@/models";
import { constructResponseSchema, UpdateUser, UserSchema } from "@/types";

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

  // Explicit route for getUser to ensure routeOptions (operationId) are populated
  // This is critical for downstream middleware/logging that relies on routeOptions
  fastify.route({
    method: "GET",
    url: "/api/auth/admin/user",
    schema: {
      operationId: RouteId.GetUser,
      description: "Get user by ID",
      tags: ["Get User"],
      querystring: z.object({
        id: z.string(),
      }),
      response: constructResponseSchema(UserSchema),
    },
    async handler(request, reply) {
      try {
        // Check if a user with the default email exists
        const user = await UserModel.getById(request.query.id);

        return reply.send({ ...user });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send();
      }
    },
  });

  // Create User (Admin)
  fastify.route({
    method: "POST",
    url: "/api/auth/admin/users",
    schema: {
      operationId: RouteId.CreateUser,
      description: "Create a new user",
      tags: ["User"],
      body: z.object({
        id: z.string().optional(),
        name: z.string(),
        email: z.string(),
        password: z.string().min(8),
        image: z.string().optional(),
      }),
      response: constructResponseSchema(UserSchema),
    },
    async handler(request, reply) {
      const { id, name, email, password, image } = request.body;

      try {
        const result = await betterAuth.api.signUpEmail({
          body: {
            id,
            name,
            email,
            password,
            image,
          },
          asResponse: false,
        });

        if (!result) {
          throw new Error("Failed to create user");
        }

        return reply.code(200).send(result.user);
      } catch (error) {
        request.log.error(error);
        if (error && typeof error === 'object' && 'status' in error) {
          // biome-ignore lint/suspicious/noExplicitAny: error typing
          const apiError = error as any;
          return reply.status(apiError.status || 500).send(apiError.body || { message: "Failed to create user" });
        }
        return reply.status(500).send();
      }
    },
  });

  // Update User (Admin)
  fastify.route({
    method: "PATCH",
    url: "/api/auth/admin/users/:id",
    schema: {
      operationId: RouteId.UpdateUser,
      description: "Update a user",
      tags: ["User"],
      params: z.object({
        id: z.string(),
      }),
      body: z.object({
        name: z.string().optional(),
        email: z.string().email().optional(),
        image: z.string().optional(),
      }),
      response: constructResponseSchema(UserSchema),
    },
    async handler(request, reply) {
      const { id } = request.params;
      const updateData = request.body;

      try {
        // Check if user exists
        const user = await UserModel.getById(id);
        if (!user) {
          return reply.status(404).send();
        }

        await UserModel.patch(id, updateData);

        // Fetch updated user to return
        const updatedUser = await UserModel.getById(id);
        if (!updatedUser) {
          return reply.status(404).send();
        }
        return reply.send({ ...updatedUser });

      } catch (error) {
        request.log.error(error);
        return reply.status(500).send();
      }
    }
  });

  // Delete User (Admin)
  fastify.route({
    method: "DELETE",
    url: "/api/auth/admin/users/:id",
    schema: {
      operationId: RouteId.DeleteUser,
      description: "Delete a user",
      tags: ["User"],
      params: z.object({
        id: z.string(),
      }),
      response: {
        200: z.object({
          success: z.boolean(),
        }),
        404: z.object({}),
        500: z.object({}),
      }
    },
    async handler(request, reply) {
      const { id } = request.params;
      try {
        // Check if user exists
        const user = await UserModel.getById(id);
        if (!user) {
          return reply.status(404).send();
        }

        // Using UserModel.delete which deletes from DB.
        // Be certain this is what is desired from the request.
        await UserModel.delete(id);
        return reply.send({ success: true });
      } catch (error) {
        request.log.error(error);
        return reply.status(500).send();
      }
    }
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
