import { MEMBER_ROLE_NAME, PermissionsSchema, RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import MemberModel from "@/models/member";
import OrganizationRoleModel from "@/models/organization-role";
import { ApiError, constructResponseSchema, UserSchema } from "@/types";
import { OrganizationModel, UserModel } from "@/models";
import logger from "@/logging";
import z from "zod";
import { betterAuth } from "@/auth";

const userRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/user/permissions",
    {
      schema: {
        operationId: RouteId.GetUserPermissions,
        description: "Get current user's permissions",
        tags: ["User"],
        response: constructResponseSchema(PermissionsSchema),
      },
    },
    async ({ user, organizationId }, reply) => {
      // Get user's member record to find their role
      const member = await MemberModel.getByUserId(user.id, organizationId);

      if (!member || !member.role) {
        throw new ApiError(404, "User is not a member of any organization");
      }

      // Get permissions for the user's role
      const permissions = await OrganizationRoleModel.getPermissions(
        member.role,
        organizationId,
      );

      return reply.send(permissions);
    },
  );

  fastify.route({
    method: "GET",
    url: "/api/users/:id",
    schema: {
      operationId: RouteId.GetUserById,
      description: "Get user by ID",
      tags: ["Get User"],
      params: z.object({
        id: z.string(),
      }),
      response: constructResponseSchema(UserSchema),
    },
    async handler(request, reply) {
      try {
        const { id } = request.params;
        const user = await UserModel.getById(id);
        logger.info(user, id);
        return reply.send(user);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send();
      }
    },
  });

  fastify.route({
    method: "GET",
    url: "/api/user/email/:email",
    schema: {
      operationId: RouteId.GetUserByEmail,
      description: "Get user by email",
      tags: ["Get User"],
      params: z.object({
        email: z.string(),
      }),
      response: constructResponseSchema(UserSchema),
    },
    async handler(request, reply) {
      try {
        const { email } = request.params;
        const user = await UserModel.findByEmail(email);

        return reply.send(user);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send();
      }
    },
  });

  // Create User (Admin)
  fastify.route({
    method: "POST",
    url: "/api/user",
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
      logger.info(request, "Creating user");
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

        let targetOrgId = request.organizationId;

        if (!targetOrgId) {
          const defaultOrg = await OrganizationModel.getOrCreateDefaultOrganization();
          targetOrgId = defaultOrg.id;
          request.log.info(
            { defaultOrgId: targetOrgId },
            "No organizationId provided, using default organization"
          );
        }

        try {
          await MemberModel.create(result.user.id, targetOrgId, MEMBER_ROLE_NAME);
          request.log.info(
            { userId: result.user.id, organizationId: targetOrgId },
            "Added new user to organization"
          );
        } catch (memberError) {
          request.log.error(
            { err: memberError, userId: result.user.id, organizationId: targetOrgId },
            "Failed to add new user to organization"
          );
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
    url: "/api/user/:id",
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
    url: "/api/user/:id",
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
        logger.info(user, id);
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
};

export default userRoutes;
