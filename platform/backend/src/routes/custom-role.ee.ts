import {
  PermissionsSchema,
  PredefinedRoleNameSchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { syncSystemRoleForRoleHolders } from "@/auth/system-role-sync";
import { enterpriseTier } from "@/enterprise-tier";
import logger from "@/logging";
import { OrganizationRoleModel, UserModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  SelectOrganizationRoleSchema,
} from "@/types";
import { BulkDeleteBodySchema, BulkOutcomeSchema, runBulk } from "./bulk-route";

const CreateUpdateRoleNameSchema = z
  .string()
  .min(1, "Role name is required")
  .max(50, "Role name must be less than 50 characters");
const RoleDescriptionSchema = z
  .string()
  .max(200)
  .transform((value) => value.trim())
  .optional()
  .transform((value) => (value ? value : undefined));

const CustomRoleIdSchema = z
  .string()
  .min(1)
  .describe("Custom role ID (base62)");
const PredefinedRoleNameOrCustomRoleIdSchema = z
  .union([PredefinedRoleNameSchema, CustomRoleIdSchema])
  .describe("Predefined role name or custom role ID");

/**
 * Generates an immutable role identifier from a human-readable name
 */
const generateRoleIdentifier = (title: string): string => {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, ""); // Remove leading/trailing underscores
};

/**
 * Custom role CRUD routes (Enterprise Edition only)
 * GET routes are in organization-role.ts (open-source)
 */
const customRoleRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    "/api/roles",
    {
      schema: {
        operationId: RouteId.CreateRole,
        description: "Create a new custom role",
        tags: ["Roles"],
        body: z.object({
          name: CreateUpdateRoleNameSchema,
          description: RoleDescriptionSchema,
          permission: PermissionsSchema,
        }),
        response: constructResponseSchema(SelectOrganizationRoleSchema),
      },
    },
    async (request, reply) => {
      assertCustomRolesLicensed();

      const { name, description, permission } = request.body;
      const { organizationId, user } = request;

      // Get user's permissions to validate they can grant these permissions
      const userPermissions = await UserModel.getUserPermissions(
        user.id,
        organizationId,
      );

      const validation = OrganizationRoleModel.validateRolePermissions(
        userPermissions,
        permission,
      );

      if (!validation.valid) {
        throw new ApiError(
          403,
          `You cannot grant permissions you don't have: ${validation.missingPermissions.join(", ")}`,
        );
      }

      const roleIdentifier = generateRoleIdentifier(name);
      await assertRoleIdentifierIsFree(roleIdentifier, organizationId);

      logger.info(
        {
          name,
          roleIdentifier,
          permission,
          organizationId,
        },
        "Creating role",
      );

      const created = await OrganizationRoleModel.create({
        organizationId,
        role: roleIdentifier,
        name,
        description,
        permission,
      }).catch(rethrowDuplicateRoleName);

      OrganizationRoleModel.invalidatePermissionsCacheForRole(
        organizationId,
        created.role,
      );

      logger.info({ roleId: created.id }, "Role created successfully");
      return reply.send(normalizeRoleResponse(created));
    },
  );

  fastify.put(
    "/api/roles/:roleId",
    {
      schema: {
        operationId: RouteId.UpdateRole,
        description: "Update a custom role",
        tags: ["Roles"],
        params: z.object({
          roleId: PredefinedRoleNameOrCustomRoleIdSchema,
        }),
        body: z.object({
          name: CreateUpdateRoleNameSchema.optional(),
          description: RoleDescriptionSchema,
          permission: PermissionsSchema.optional(),
        }),
        response: constructResponseSchema(SelectOrganizationRoleSchema),
      },
    },
    async (
      {
        params: { roleId },
        body: { name, description, permission },
        user,
        organizationId,
      },
      reply,
    ) => {
      assertCustomRolesLicensed();

      // Cannot update predefined roles
      if (OrganizationRoleModel.isPredefinedRole(roleId)) {
        throw new ApiError(403, "Cannot update predefined roles");
      }

      // Check if role exists
      const existingRole = await OrganizationRoleModel.getById(
        roleId,
        organizationId,
      );

      if (!existingRole) {
        throw new ApiError(404, "Role not found");
      }

      // Validate permissions if being changed
      if (permission) {
        const userPermissions = await UserModel.getUserPermissions(
          user.id,
          organizationId,
        );

        const validation = OrganizationRoleModel.validateRolePermissions(
          userPermissions,
          permission,
        );

        if (!validation.valid) {
          throw new ApiError(
            403,
            `You cannot grant permissions you don't have: ${validation.missingPermissions.join(", ")}`,
          );
        }
      }

      const updated = await OrganizationRoleModel.update({
        id: roleId,
        organizationId,
        name,
        description,
        permission,
      });

      if (!updated) {
        throw new ApiError(404, "Role not found");
      }

      OrganizationRoleModel.invalidatePermissionsCacheForRole(
        organizationId,
        updated.role,
      );

      // The role's member:impersonate grant may have appeared or vanished;
      // resync the system-level user.role of everyone holding it (the
      // better-auth admin plugin gates impersonation on that column).
      if (permission) {
        await syncSystemRoleForRoleHolders(updated.role, organizationId);
      }

      return reply.send(normalizeRoleResponse(updated));
    },
  );

  fastify.delete(
    "/api/roles/bulk",
    {
      schema: {
        operationId: RouteId.BulkDeleteRoles,
        description:
          "Delete several custom roles in one request. A role that cannot be " +
          "deleted — a predefined one, or one still held by a member — is " +
          "reported in `failed` with that reason, and the rest of the batch " +
          "still applies.",
        tags: ["Roles"],
        body: BulkDeleteBodySchema,
        response: constructResponseSchema(BulkOutcomeSchema),
      },
    },
    async (request, reply) => {
      const { organizationId } = request;
      const snapshot = async (ids: string[]) => {
        const roles = await Promise.all(
          ids.map((id) => OrganizationRoleModel.getById(id, organizationId)),
        );
        return {
          roles: roles
            .filter((role) => role !== null)
            .map((role) => ({ id: role.id, role: role.role }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        };
      };

      const outcome = await runBulk({
        ids: request.body.ids,
        logLabel: "roles bulk delete",
        notFoundMessage: "Role not found",
        unexpectedMessage: "Could not delete this role",
        load: async (ids) => {
          const roles = await Promise.all(
            ids.map((id) => OrganizationRoleModel.getById(id, organizationId)),
          );
          return new Map(
            roles
              .filter((role) => role !== null)
              .map((role) => [role.id, role] as const),
          );
        },
        describe: (role) => role.role,
        authorize: async (role) => {
          const check = await OrganizationRoleModel.canDelete(
            role.id,
            organizationId,
          );
          if (!check.canDelete) {
            throw new ApiError(400, check.reason || "Cannot delete role");
          }
        },
        applyEach: async (role) => {
          await OrganizationRoleModel.delete(role.id, organizationId);
          OrganizationRoleModel.invalidatePermissionsCacheForRole(
            organizationId,
            role.role,
          );
        },
        audit: { target: request, snapshot },
      });

      return reply.send(outcome);
    },
  );

  fastify.delete(
    "/api/roles/:roleId",
    {
      schema: {
        operationId: RouteId.DeleteRole,
        description: "Delete a custom role",
        tags: ["Roles"],
        params: z.object({
          roleId: CustomRoleIdSchema,
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { roleId }, organizationId }, reply) => {
      // Check if role exists first
      const role = await OrganizationRoleModel.getById(roleId, organizationId);
      if (!role) {
        throw new ApiError(404, "Role not found");
      }

      // Check if role can be deleted
      const deleteCheck = await OrganizationRoleModel.canDelete(
        roleId,
        organizationId,
      );

      if (!deleteCheck.canDelete) {
        throw new ApiError(400, deleteCheck.reason || "Cannot delete role");
      }

      await OrganizationRoleModel.delete(roleId, organizationId);

      OrganizationRoleModel.invalidatePermissionsCacheForRole(
        organizationId,
        role.role,
      );

      return reply.send({ success: true });
    },
  );
};

export default customRoleRoutes;

// === Internal helpers

/**
 * Custom roles are an enterprise feature, with the small-team allowance
 * applied (see `enterpriseTier`). Only the operations that ADD to an
 * organization's RBAC configuration are refused without a licence: creating a
 * role, and editing an existing one — an ungated edit would be a create in
 * disguise, since renaming a role and rewriting its permissions produces a new
 * role in all but id.
 *
 * Deleting stays open on purpose. It is the unwind direction, it grants
 * nothing, and a deployment that grows past the free-tier threshold must still
 * be able to remove the custom roles it made while under it. (Same shape as
 * two-factor enrolment in `better-auth.ts`, where enabling is gated but
 * disabling is not.) Reads stay open too: permission resolution depends on
 * them, and the roles page renders its list dimmed rather than empty.
 */
function assertCustomRolesLicensed(): void {
  if (!enterpriseTier.isCoreActive()) {
    throw new ApiError(
      403,
      "Custom roles are an enterprise feature. Please contact " +
        "sales@archestra.ai to enable it.",
    );
  }
}

/**
 * A custom role's identifier must not collide with a predefined role name or
 * with another custom role in the same organization. The unique index on
 * (organization_id, role) is the real guard — this check exists to return a
 * useful message instead of a constraint violation in the common case.
 */
async function assertRoleIdentifierIsFree(
  roleIdentifier: string,
  organizationId: string,
): Promise<void> {
  if (!roleIdentifier) {
    throw new ApiError(
      400,
      "Role name must contain at least one letter or number",
    );
  }

  if (OrganizationRoleModel.isPredefinedRole(roleIdentifier)) {
    throw new ApiError(
      400,
      `"${roleIdentifier}" is a predefined role name and cannot be used for a custom role`,
    );
  }

  const existing = await OrganizationRoleModel.getByIdentifier(
    roleIdentifier,
    organizationId,
  );
  if (existing) {
    throw new ApiError(400, "That role name is already taken");
  }
}

/** Two creates racing on the same name land here rather than as a 500. */
function rethrowDuplicateRoleName(error: unknown): never {
  const err = error as { code?: string; cause?: { code?: string } };
  if (
    err.code === POSTGRES_UNIQUE_VIOLATION ||
    err.cause?.code === POSTGRES_UNIQUE_VIOLATION
  ) {
    throw new ApiError(400, "That role name is already taken");
  }
  throw error;
}

const POSTGRES_UNIQUE_VIOLATION = "23505";

function normalizeRoleResponse(roleData: {
  id: string;
  organizationId: string;
  role: string;
  name: string;
  description?: string | null;
  permission: unknown;
  createdAt: Date | string;
  updatedAt?: Date | string | null;
}) {
  return {
    id: roleData.id,
    organizationId: roleData.organizationId,
    role: roleData.role,
    name: roleData.name,
    description: roleData.description ?? null,
    permission: parsePermissions(roleData.permission),
    createdAt: toDate(roleData.createdAt),
    updatedAt: roleData.updatedAt ? toDate(roleData.updatedAt) : null,
    predefined: false,
  };
}

function parsePermissions(value: unknown) {
  return OrganizationRoleModel.sanitizePermissions(value);
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
