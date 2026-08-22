"use client";

import { Trash2 } from "lucide-react";
import type { TableRowAction } from "@/components/table-row-actions";

/**
 * The "Delete permanently" trash action.
 *
 * Permanent delete is gated on a built-in admin ROLE, not on a permission:
 * `agent:admin`, `skill:admin` and `project:admin` are oversight grants (see
 * the trash, restore from it), while destroying data past recovery is the
 * deployment owner's call. The routes answer 404 to everyone else, so this
 * cannot go through `PermissionButton` — no permission set describes the gate.
 */

/**
 * The action's name, everywhere it appears: the row action below, and the
 * `confirmLabel` of the dialog it opens. Shared so the button a user clicks
 * and the button that confirms it cannot drift apart.
 */
export const PERMANENT_DELETE_LABEL = "Delete permanently";

/**
 * Row action for a trash view rendered with `TableRowActions`. Callers resolve
 * the role once in their component body (`useIsGlobalAdmin`) and pass the whole
 * result as `admin`, rather than calling a hook inside a table cell renderer.
 *
 * `disabledReason` is for an entity-specific refusal the API would answer
 * anyway (a built-in skill, say) and takes precedence over the role gate: a
 * user who cannot act on the row at all should be told why, not sent to find
 * an admin who would hit the same wall.
 */
export function permanentDeleteRowAction({
  admin,
  onClick,
  disabledReason,
}: {
  admin: AdminGate;
  onClick: () => void;
  disabledReason?: string;
}): TableRowAction {
  const reason = disabledReason ?? adminGateReason(admin);
  return {
    icon: <Trash2 className="h-4 w-4" />,
    label: PERMANENT_DELETE_LABEL,
    variant: "destructive",
    disabled: !!reason,
    disabledTooltip: reason,
    onClick,
  };
}

// === internal ===

/** The shape `useIsGlobalAdmin()` returns, taken whole so neither half can be dropped. */
type AdminGate = { isGlobalAdmin: boolean; isLoading: boolean };

/**
 * Why the action is disabled, or `undefined` when it isn't. The role resolves
 * to "not an admin" while it loads, so that state needs its own reason —
 * telling a real admin they lack the role is worse than saying nothing yet.
 */
function adminGateReason({
  isGlobalAdmin,
  isLoading,
}: AdminGate): string | undefined {
  if (isGlobalAdmin) return undefined;
  return isLoading ? PERMANENT_DELETE_CHECKING : PERMANENT_DELETE_ADMIN_ONLY;
}

const PERMANENT_DELETE_ADMIN_ONLY =
  "Only an Admin or Platform Admin can permanently delete";

const PERMANENT_DELETE_CHECKING = "Checking your role…";
