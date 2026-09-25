import type { Action, Resource } from "./permission.types";

/** One permission decision shared by browser gating and backend enforcement. */
export function isPermissionActionGranted({
  grantedActions,
  requiredAction,
}: {
  resource: Resource;
  grantedActions: readonly Action[];
  requiredAction: Action;
}): boolean {
  return grantedActions.includes(requiredAction);
}
