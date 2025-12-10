import type { Permissions } from "./permission.types";
import type { RouteId } from "./routes";
export const allAvailableActions: Permissions = {};

export const editorPermissions: Permissions = {};

export const memberPermissions: Permissions = {};

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
