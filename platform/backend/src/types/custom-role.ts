import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectRoleSchema = createSelectSchema(schema.roleTable);
export const InsertRoleSchema = createInsertSchema(schema.roleTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const UpdateRoleSchema = createUpdateSchema(schema.roleTable).omit({
  id: true,
  organizationId: true,
  createdAt: true,
});

export type Role = z.infer<typeof SelectRoleSchema>;
export type InsertRole = z.infer<typeof InsertRoleSchema>;
export type UpdateRole = z.infer<typeof UpdateRoleSchema>;

// Request/Response schemas for API
export const CreateRoleBodySchema = z.object({
  name: z.string().min(1).max(255).describe("Role name"),
  description: z
    .string()
    .max(500)
    .optional()
    .describe("Role description"),
  permissions: z
    .array(z.string())
    .min(1)
    .describe("Array of permission strings"),
});

export const UpdateRoleBodySchema = z.object({
  name: z.string().min(1).max(255).optional().describe("Role name"),
  description: z
    .string()
    .max(500)
    .optional()
    .describe("Role description"),
  permissions: z
    .array(z.string())
    .min(1)
    .optional()
    .describe("Array of permission strings"),
});

export type CreateRoleBody = z.infer<typeof CreateRoleBodySchema>;
export type UpdateRoleBody = z.infer<typeof UpdateRoleBodySchema>;
