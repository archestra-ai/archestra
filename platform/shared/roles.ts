import { z } from "zod";

export const ADMIN_ROLE_NAME = "admin";
export const PLATFORM_ADMIN_ROLE_NAME = "platform_admin";
export const EDITOR_ROLE_NAME = "editor";
export const MEMBER_ROLE_NAME = "member";
export const PredefinedRoleNameSchema = z.enum([
  ADMIN_ROLE_NAME,
  PLATFORM_ADMIN_ROLE_NAME,
  EDITOR_ROLE_NAME,
  MEMBER_ROLE_NAME,
]);

export type PredefinedRoleName = z.infer<typeof PredefinedRoleNameSchema>;

export const roleDescriptions: Record<PredefinedRoleName, string> = {
  admin:
    "Full access to all resources including user management, roles, and platform settings",
  platform_admin:
    "Runs the platform — everything an admin can do, except reading other users' logs, reading the audit log, and impersonating users",
  editor:
    "Full access to core resources and settings, but cannot manage users, roles, or identity providers",
  member:
    "Can manage agents, tools, and chat, with read-only access to most other resources",
};

const AnyRoleName = PredefinedRoleNameSchema.or(z.string());
export type AnyRoleName = z.infer<typeof AnyRoleName>;
