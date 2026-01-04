import {
  createInsertSchema,
  createSelectSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectUserRoleAssignmentSchema = createSelectSchema(
  schema.userRoleAssignmentTable,
);
export const InsertUserRoleAssignmentSchema = createInsertSchema(
  schema.userRoleAssignmentTable,
).omit({
  id: true,
  assignedAt: true,
});

export type UserRoleAssignment = z.infer<
  typeof SelectUserRoleAssignmentSchema
>;
export type InsertUserRoleAssignment = z.infer<
  typeof InsertUserRoleAssignmentSchema
>;

// Request/Response schemas for API
export const AssignRoleToUserBodySchema = z.object({
  roleId: z.string().describe("ID of the role to assign"),
});

export type AssignRoleToUserBody = z.infer<
  typeof AssignRoleToUserBodySchema
>;
