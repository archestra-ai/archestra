import type { Action, Resource } from "@shared";
import { z } from "zod";

/**
 * Schemas for role API requests and responses
 */

export const CreateRoleBodySchema = z.object({
  name: z
    .string()
    .min(1, "Role name is required")
    .max(50, "Role name must be less than 50 characters")
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      "Role name can only contain letters, numbers, hyphens, and underscores",
    ),
  permissions: z.record(
    z.string(), // Resource
    z.array(z.enum(["create", "read", "update", "delete"])), // Actions
  ),
});

export const UpdateRoleBodySchema = z.object({
  name: z
    .string()
    .min(1, "Role name is required")
    .max(50, "Role name must be less than 50 characters")
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      "Role name can only contain letters, numbers, hyphens, and underscores",
    )
    .optional(),
  permissions: z
    .record(
      z.string(), // Resource
      z.array(z.enum(["create", "read", "update", "delete"])), // Actions
    )
    .optional(),
});

export const RoleResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  permissions: z.record(
    z.string(), // Resource
    z.array(z.enum(["create", "read", "update", "delete"])), // Actions
  ),
  isCustom: z.boolean(),
  organizationId: z.string(),
  createdAt: z.date().or(z.string()),
  updatedAt: z.date().or(z.string()),
});

export const RoleListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  isCustom: z.boolean(),
  memberCount: z.number().default(0),
  organizationId: z.string(),
  createdAt: z.date().or(z.string()),
  updatedAt: z.date().or(z.string()),
});

export type CreateRoleBody = z.infer<typeof CreateRoleBodySchema>;
export type UpdateRoleBody = z.infer<typeof UpdateRoleBodySchema>;
export type RoleResponse = z.infer<typeof RoleResponseSchema>;
export type RoleListItem = z.infer<typeof RoleListItemSchema>;
