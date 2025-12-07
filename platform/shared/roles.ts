import { z } from "zod";

export const ADMIN_ROLE_NAME = "admin";
export const EDITOR_ROLE_NAME = "editor";
export const MEMBER_ROLE_NAME = "member";
export const PredefinedRoleNameSchema = z.enum([
  ADMIN_ROLE_NAME,
  EDITOR_ROLE_NAME,
  MEMBER_ROLE_NAME,
]);

export type PredefinedRoleName = z.infer<typeof PredefinedRoleNameSchema>;

const AnyRoleName = PredefinedRoleNameSchema.or(z.string());
export type AnyRoleName = z.infer<typeof AnyRoleName>;
