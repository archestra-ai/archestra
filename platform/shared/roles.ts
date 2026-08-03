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

/**
 * Display names for the predefined roles. The identifiers are snake_case for
 * better-auth, but CSS `capitalize` only touches the first letter — which
 * rendered `platform_admin` as "Platform_admin" in the roles UI.
 */
export const roleDisplayNames: Record<PredefinedRoleName, string> = {
  admin: "Admin",
  platform_admin: "Platform Admin",
  editor: "Editor",
  member: "Member",
};

export const roleDescriptions: Record<PredefinedRoleName, string> = {
  admin:
    "Full access to all resources including user management, roles, and platform settings",
  platform_admin:
    "Runs the platform — everything an admin can do, except reading other users' logs, reading the audit log, impersonating users, and acting through other users' MCP connections",
  editor:
    "Full access to core resources and settings, but cannot manage users, roles, or identity providers",
  member:
    "Can manage agents, tools, and chat, with read-only access to most other resources",
};

/**
 * Human-readable label for any role identifier: the curated name for a
 * predefined role, otherwise the custom role's identifier with separators
 * turned back into spaces (custom roles carry their own display name, so
 * this is the fallback for places that only have the identifier).
 */
export function getRoleDisplayName(role: string): string {
  if (role in roleDisplayNames) {
    return roleDisplayNames[role as PredefinedRoleName];
  }
  return role.replace(/[_-]+/g, " ");
}

const AnyRoleName = PredefinedRoleNameSchema.or(z.string());
export type AnyRoleName = z.infer<typeof AnyRoleName>;
