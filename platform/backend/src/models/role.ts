import { and, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import type { InsertRole, Role, UpdateRole } from "@/types";
import { ApiError } from "@/types";

class RoleModel {
  /**
   * Create a new custom role
   */
  static async create(
    input: Omit<InsertRole, "organizationId"> & { organizationId: string },
  ): Promise<Role> {
    logger.debug(
      { name: input.name, organizationId: input.organizationId },
      "RoleModel.create: creating role",
    );

    const roleId = crypto.randomUUID();
    const now = new Date();

    // Check for duplicate role name in organization
    const existingRole = await RoleModel.findByName(
      input.organizationId,
      input.name,
    );
    if (existingRole) {
      throw new ApiError(409, `Role with name "${input.name}" already exists`);
    }

    // Validate permissions array is not empty
    if (!input.permissions || input.permissions.length === 0) {
      throw new ApiError(400, "Permissions array cannot be empty");
    }

    const [role] = await db
      .insert(schema.roleTable)
      .values({
        id: roleId,
        organizationId: input.organizationId,
        name: input.name,
        description: input.description || null,
        permissions: input.permissions,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    logger.debug({ roleId }, "RoleModel.create: completed");
    return role;
  }

  /**
   * Get a role by ID
   */
  static async findById(id: string): Promise<Role | null> {
    logger.debug({ id }, "RoleModel.findById: fetching role");
    const [role] = await db
      .select()
      .from(schema.roleTable)
      .where(eq(schema.roleTable.id, id))
      .limit(1);

    logger.debug({ id, found: !!role }, "RoleModel.findById: completed");
    return role || null;
  }

  /**
   * Get a role by name within an organization
   */
  static async findByName(
    organizationId: string,
    name: string,
  ): Promise<Role | null> {
    logger.debug(
      { organizationId, name },
      "RoleModel.findByName: fetching role",
    );
    const [role] = await db
      .select()
      .from(schema.roleTable)
      .where(
        and(
          eq(schema.roleTable.organizationId, organizationId),
          eq(schema.roleTable.name, name),
        ),
      )
      .limit(1);

    logger.debug(
      { organizationId, name, found: !!role },
      "RoleModel.findByName: completed",
    );
    return role || null;
  }

  /**
   * Get all roles for an organization
   */
  static async findByOrganization(organizationId: string): Promise<Role[]> {
    logger.debug(
      { organizationId },
      "RoleModel.findByOrganization: fetching roles",
    );
    const roles = await db
      .select()
      .from(schema.roleTable)
      .where(eq(schema.roleTable.organizationId, organizationId));

    logger.debug(
      { organizationId, count: roles.length },
      "RoleModel.findByOrganization: completed",
    );
    return roles;
  }

  /**
   * Update a role
   */
  static async update(id: string, input: UpdateRole): Promise<Role | null> {
    logger.debug({ id }, "RoleModel.update: updating role");

    const role = await RoleModel.findById(id);
    if (!role) {
      return null;
    }

    // If updating name, check for duplicates in the same organization
    if (input.name && input.name !== role.name) {
      const existingRole = await RoleModel.findByName(
        role.organizationId,
        input.name,
      );
      if (existingRole) {
        throw new ApiError(409, `Role with name "${input.name}" already exists`);
      }
    }

    // Validate permissions if provided
    if (input.permissions !== undefined && input.permissions.length === 0) {
      throw new ApiError(400, "Permissions array cannot be empty");
    }

    const now = new Date();

    const [updated] = await db
      .update(schema.roleTable)
      .set({
        name: input.name || role.name,
        description: input.description !== undefined ? input.description : role.description,
        permissions: input.permissions || role.permissions,
        updatedAt: now,
      })
      .where(eq(schema.roleTable.id, id))
      .returning();

    logger.debug({ id }, "RoleModel.update: completed");
    return updated;
  }

  /**
   * Delete a role
   */
  static async delete(id: string): Promise<boolean> {
    logger.debug({ id }, "RoleModel.delete: deleting role");

    const role = await RoleModel.findById(id);
    if (!role) {
      return false;
    }

    // Check if role is assigned to any users
    const assignments = await db
      .select()
      .from(schema.userRoleAssignmentTable)
      .where(eq(schema.userRoleAssignmentTable.roleId, id))
      .limit(1);

    if (assignments.length > 0) {
      throw new ApiError(
        409,
        "Cannot delete role that is assigned to users. Remove all assignments first.",
      );
    }

    await db.delete(schema.roleTable).where(eq(schema.roleTable.id, id));

    logger.debug({ id }, "RoleModel.delete: completed");
    return true;
  }
}

export default RoleModel;
