import { defaultStatements } from "better-auth/plugins/organization/access";
import type { Permissions } from "./permission.types";
import type { RouteId } from "./routes";

// Include better-auth's default permissions for organization operations
// This ensures basic operations like invitations work in non-EE mode
export const allAvailableActions: Permissions = defaultStatements;

export const editorPermissions: Permissions = defaultStatements;

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
