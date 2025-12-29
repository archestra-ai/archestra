import { defaultStatements } from "better-auth/plugins/organization/access";
import type { Permissions } from "./permission.types";
import type { RouteId } from "./routes";

// Include better-auth's default permissions for organization operations
// This ensures basic operations like invitations work in non-EE mode
// We need to convert readonly arrays to mutable arrays for TypeScript compatibility
export const allAvailableActions: Permissions = Object.fromEntries(
  Object.entries(defaultStatements).map(([key, value]) => [
    key,
    [...value], // Convert readonly array to mutable array
  ]),
);

export const editorPermissions: Permissions = Object.fromEntries(
  Object.entries(defaultStatements).map(([key, value]) => [
    key,
    [...value], // Convert readonly array to mutable array
  ]),
);

export const memberPermissions: Permissions = {
  organization: ["read"],
  team: ["read"],
};

// Allows all endpoints
export const requiredEndpointPermissionsMap = new Proxy(
  {} as Record<RouteId, Permissions>,
  {
    get: (_target, _prop) => ({}), // Return empty object for any route
  },
);

// Allows all pages
export const requiredPagePermissionsMap = new Proxy(
  {} as Record<string, Permissions>,
  {
    get: (_target, _prop) => ({}),
  },
);
