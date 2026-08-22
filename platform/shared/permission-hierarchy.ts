import type { Action, Resource } from "./permission.types";

/** One permission decision shared by browser gating and backend enforcement. */
export function isPermissionActionGranted({
  resource,
  grantedActions,
  requiredAction,
}: {
  resource: Resource;
  grantedActions: readonly Action[];
  requiredAction: Action;
}): boolean {
  if (grantedActions.includes(requiredAction)) return true;
  return (
    resource === "mcpServerInstallation" &&
    grantedActions.includes("admin") &&
    MCP_INSTALLATION_ADMIN_CRUD_ACTIONS.has(requiredAction)
  );
}

const MCP_INSTALLATION_ADMIN_CRUD_ACTIONS = new Set<Action>([
  "read",
  "create",
  "update",
  "delete",
]);
