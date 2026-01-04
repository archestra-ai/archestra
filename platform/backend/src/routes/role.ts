import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import {
  RoleModel,
} from "@/models";
import {
  ApiError,
  constructResponseSchema,
  CreateRoleBodySchema,
  DeleteObjectResponseSchema,
  SelectRoleSchema,
  UpdateRoleBodySchema,
} from "@/types";

const roleRoutes: FastifyPluginAsyncZod = async (fastify) => {
  /**
   * GET /api/custom-roles
   * Get all custom roles in the organization
   */
  fastify.get(
    "/api/custom-roles",
    {
      schema: {
        operationId: RouteId.GetRoles,
        description: "Get all custom roles in the organization",
        tags: ["Custom Roles"],
        response: constructResponseSchema(z.array(SelectRoleSchema)),
      },
    },
    async (request, reply) => {
      // Check if user has permission to view roles (admin only)
      const { success: hasAdminPermission } = await hasPermission(
        { organization: ["update"] },
        request.headers,
      );

      if (!hasAdminPermission) {
        throw new ApiError(
          403,
          "Only organization admins can view roles",
        );
      }

      const roles = await RoleModel.findByOrganization(
        request.organizationId,
      );
      return reply.send(roles);
    },
  );

  /**
   * POST /api/custom-roles
   * Create a new custom role
   */
  fastify.post(
    "/api/custom-roles",
    {
      schema: {
        operationId: RouteId.CreateRole,
        description: "Create a new custom role",
        tags: ["Custom Roles"],
        body: CreateRoleBodySchema,
        response: constructResponseSchema(SelectRoleSchema),
      },
    },
    async (request, reply) => {
      // Check if user has permission to create roles (admin only)
      const { success: hasAdminPermission } = await hasPermission(
        { organization: ["update"] },
        request.headers,
      );

      if (!hasAdminPermission) {
        throw new ApiError(
          403,
          "Only organization admins can create roles",
        );
      }

      const { name, description, permissions } = request.body;

      const role = await RoleModel.create({
        organizationId: request.organizationId,
        name,
        description: description || undefined,
        permissions,
      });

      // Align with OpenAPI spec which returns 200 for successful creation
      return reply.status(200).send(role);
    },
  );

  /**
   * GET /api/custom-roles/:id
   * Get a role by ID
   */
  fastify.get(
    "/api/custom-roles/:id",
    {
      schema: {
        operationId: RouteId.GetRole,
        description: "Get a role by ID",
        tags: ["Custom Roles"],
        params: z.object({
          id: z.string().describe("Role ID"),
        }),
        response: constructResponseSchema(SelectRoleSchema),
      },
    },
    async (request, reply) => {
      // Check if user has permission to view roles (admin only)
      const { success: hasAdminPermission } = await hasPermission(
        { organization: ["update"] },
        request.headers,
      );

      if (!hasAdminPermission) {
        throw new ApiError(
          403,
          "Only organization admins can view roles",
        );
      }

      const { id } = request.params;
      const role = await RoleModel.findById(id);

      if (!role) {
        throw new ApiError(404, "Role not found");
      }

      // Verify the role belongs to the user's organization
      if (role.organizationId !== request.organizationId) {
        throw new ApiError(404, "Role not found");
      }

      return reply.send(role);
    },
  );

  /**
   * GET /api/custom-roles/by-name/:name
   * Get a role by name (for Terraform data source)
   */
  fastify.get(
    "/api/custom-roles/by-name/:name",
    {
      schema: {
        operationId: RouteId.GetRoleByName,
        description: "Get a role by name",
        tags: ["Custom Roles"],
        params: z.object({
          name: z.string().describe("Role name"),
        }),
        response: constructResponseSchema(SelectRoleSchema),
      },
    },
    async (request, reply) => {
      // Check if user has permission to view roles (admin only)
      const { success: hasAdminPermission } = await hasPermission(
        { organization: ["update"] },
        request.headers,
      );

      if (!hasAdminPermission) {
        throw new ApiError(
          403,
          "Only organization admins can view roles",
        );
      }

      const { name } = request.params;
      const role = await RoleModel.findByName(
        request.organizationId,
        name,
      );

      if (!role) {
        throw new ApiError(404, "Role not found");
      }

      return reply.send(role);
    },
  );

  /**
   * PUT /api/custom-roles/:id
   * Update a role
   */
  fastify.put(
    "/api/custom-roles/:id",
    {
      schema: {
        operationId: RouteId.UpdateRole,
        description: "Update a role",
        tags: ["Custom Roles"],
        params: z.object({
          id: z.string().describe("Role ID"),
        }),
        body: UpdateRoleBodySchema,
        response: constructResponseSchema(SelectRoleSchema),
      },
    },
    async (request, reply) => {
      // Check if user has permission to update roles (admin only)
      const { success: hasAdminPermission } = await hasPermission(
        { organization: ["update"] },
        request.headers,
      );

      if (!hasAdminPermission) {
        throw new ApiError(
          403,
          "Only organization admins can update roles",
        );
      }

      const { id } = request.params;
      const { name, description, permissions } = request.body;

      // Verify role exists and belongs to organization
      const role = await RoleModel.findById(id);
      if (!role) {
        throw new ApiError(404, "Role not found");
      }

      if (role.organizationId !== request.organizationId) {
        throw new ApiError(404, "Role not found");
      }

      const updated = await RoleModel.update(id, {
        name,
        description,
        permissions,
      });

      if (!updated) {
        throw new ApiError(404, "Role not found");
      }

      return reply.send(updated);
    },
  );

  /**
   * DELETE /api/custom-roles/:id
   * Delete a role
   */
  fastify.delete(
    "/api/custom-roles/:id",
    {
      schema: {
        operationId: RouteId.DeleteRole,
        description: "Delete a role",
        tags: ["Custom Roles"],
        params: z.object({
          id: z.string().describe("Role ID"),
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async (request, reply) => {
      // Check if user has permission to delete roles (admin only)
      const { success: hasAdminPermission } = await hasPermission(
        { organization: ["update"] },
        request.headers,
      );

      if (!hasAdminPermission) {
        throw new ApiError(
          403,
          "Only organization admins can delete roles",
        );
      }

      const { id } = request.params;

      // Verify role exists and belongs to organization
      const role = await RoleModel.findById(id);
      if (!role) {
        throw new ApiError(404, "Role not found");
      }

      if (role.organizationId !== request.organizationId) {
        throw new ApiError(404, "Role not found");
      }

      await RoleModel.delete(id);

      return reply.send({ success: true });
    },
  );
};

export default roleRoutes;
