import type { RouteId } from "./routes";

export const allAvailableActions = {};

export const editorPermissions = {};

export const memberPermissions = {};

// Allows all endpoints
export const requiredEndpointPermissionsMap = new Proxy(
  {} as Record<RouteId, Record<string, string[]>>,
  {
    get: (_target, _prop) => ({}), // Return empty object for any route
  },
);

// Allows all pages
export const requiredPagePermissionsMap = new Proxy(
  {} as Record<string, Record<string, string[]>>,
  {
    get: (_target, _prop) => ({}),
  },
);
