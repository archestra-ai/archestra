import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import type { InsertUserRoleAssignment, UserRoleAssignment } from "@/types";
import { ApiError } from "@/types";

class UserRoleAssignmentModel {
  /**
   * Assign a role to a user
   */
  static async create(
    input: InsertUserRoleAssignment,
  ): Promise<UserRoleAssignment> {
    logger.debug(
      { userId: input.userId, roleId: input.roleId },
      "UserRoleAssignmentModel.create: assigning role to user",
    );

    const assignmentId = crypto.randomUUID();
    const now = new Date();

    // Check if assignment already exists
    const existing = await UserRoleAssignmentModel.findByUserAndRole(
      input.userId,
      input.roleId,
    );
    if (existing) {
      throw new ApiError(
        409,
        "User already has this role assigned",
      );
    }

    // Validate user exists
    const user = await db
      .select()
      .from(schema.usersTable)
      .where(eq(schema.usersTable.id, input.userId))
      .limit(1);
    if (!user.length) {
      throw new ApiError(404, "User not found");
    }

    // Validate role exists
    const role = await db
      .select()
      .from(schema.roleTable)
      .where(eq(schema.roleTable.id, input.roleId))
      .limit(1);
    if (!role.length) {
      throw new ApiError(404, "Role not found");
    }

    const [assignment] = await db
      .insert(schema.userRoleAssignmentTable)
      .values({
        id: assignmentId,
        userId: input.userId,
        roleId: input.roleId,
        assignedAt: now,
      })
      .returning();

    logger.debug(
      { userId: input.userId, roleId: input.roleId, assignmentId },
      "UserRoleAssignmentModel.create: completed",
    );
    return assignment;
  }

  /**
   * Find a role assignment by user and role
   */
  static async findByUserAndRole(
    userId: string,
    roleId: string,
  ): Promise<UserRoleAssignment | null> {
    logger.debug(
      { userId, roleId },
      "UserRoleAssignmentModel.findByUserAndRole: fetching assignment",
    );
    const [assignment] = await db
      .select()
      .from(schema.userRoleAssignmentTable)
      .where(
        and(
          eq(schema.userRoleAssignmentTable.userId, userId),
          eq(schema.userRoleAssignmentTable.roleId, roleId),
        ),
      )
      .limit(1);

    logger.debug(
      { userId, roleId, found: !!assignment },
      "UserRoleAssignmentModel.findByUserAndRole: completed",
    );
    return assignment || null;
  }

  /**
   * Get all role assignments for a user
   */
  static async findByUser(userId: string): Promise<UserRoleAssignment[]> {
    logger.debug(
      { userId },
      "UserRoleAssignmentModel.findByUser: fetching assignments",
    );
    const assignments = await db
      .select()
      .from(schema.userRoleAssignmentTable)
      .where(eq(schema.userRoleAssignmentTable.userId, userId));

    logger.debug(
      { userId, count: assignments.length },
      "UserRoleAssignmentModel.findByUser: completed",
    );
    return assignments;
  }

  /**
   * Get a specific role assignment by ID
   */
  static async findById(id: string): Promise<UserRoleAssignment | null> {
    logger.debug({ id }, "UserRoleAssignmentModel.findById: fetching assignment");
    const [assignment] = await db
      .select()
      .from(schema.userRoleAssignmentTable)
      .where(eq(schema.userRoleAssignmentTable.id, id))
      .limit(1);

    logger.debug(
      { id, found: !!assignment },
      "UserRoleAssignmentModel.findById: completed",
    );
    return assignment || null;
  }

  /**
   * Remove a role assignment
   */
  static async delete(id: string): Promise<void> {
    logger.debug({ id }, "UserRoleAssignmentModel.delete: deleting assignment");

    const assignment = await UserRoleAssignmentModel.findById(id);
    if (!assignment) {
      throw new ApiError(404, "Role assignment not found");
    }

    await db
      .delete(schema.userRoleAssignmentTable)
      .where(eq(schema.userRoleAssignmentTable.id, id));

    logger.debug({ id }, "UserRoleAssignmentModel.delete: completed");
  }

  /**
   * Remove a role from a user by user ID and role ID
   */
  static async deleteByUserAndRole(
    userId: string,
    roleId: string,
  ): Promise<void> {
    logger.debug(
      { userId, roleId },
      "UserRoleAssignmentModel.deleteByUserAndRole: deleting assignment",
    );

    const assignment = await UserRoleAssignmentModel.findByUserAndRole(
      userId,
      roleId,
    );
    if (!assignment) {
      throw new ApiError(404, "User does not have this role assigned");
    }

    await db
      .delete(schema.userRoleAssignmentTable)
      .where(
        and(
          eq(schema.userRoleAssignmentTable.userId, userId),
          eq(schema.userRoleAssignmentTable.roleId, roleId),
        ),
      );

    logger.debug(
      { userId, roleId },
      "UserRoleAssignmentModel.deleteByUserAndRole: completed",
    );
  }
}

export default UserRoleAssignmentModel;
