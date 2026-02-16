/**
 * Permission type definitions for compile-time type safety.
 *
 * This file is necessary for both free and EE builds to provide type safety
 * for permission-related code, even though the non-EE version has no RBAC logic.
 *
 * - non-EE version: Uses these types but runtime logic always allows everything
 * - EE version: Uses these types with actual permission enforcement
 */
import { z } from "zod";

export const actions = [
  "create",
  "read",
  "update",
  "delete",
  "admin",
  "cancel",
] as const;

export const resources = [
  "profile",
  "tool",
  "policy",
  "interaction",
  "dualLlmConfig",
  "dualLlmResult",
  "organization",
  "identityProvider",
  "member",
  "invitation",
  "internalMcpCatalog",
  "mcpServer",
  "mcpServerInstallationRequest",
  "mcpToolCall",
  "team",
  "conversation",
  "limit",
  "tokenPrice",
  "chatSettings",
  "prompt",
  /**
   * Better-auth access control resource - needed for organization role management
   * See: https://github.com/better-auth/better-auth/issues/2336#issuecomment-2820620809
   *
   * The "ac" resource is part of better-auth's defaultStatements from organization plugin
   * and is required for dynamic access control to work correctly with custom roles
   */
  "ac",
] as const;

export type Resource = (typeof resources)[number];
export type Action = (typeof actions)[number];
export type Permissions = Partial<Record<Resource, Action[]>>;

export const PermissionsSchema = z.partialRecord(
  z.enum(resources),
  z.array(z.enum(actions)),
);
