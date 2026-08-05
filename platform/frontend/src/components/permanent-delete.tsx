"use client";

import { Trash2 } from "lucide-react";
import type { TableRowAction } from "@/components/table-row-actions";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useIsGlobalAdmin } from "@/lib/organization.query";

/**
 * The "Delete permanently" trash action, in the two shapes the trash views
 * need.
 *
 * Permanent delete is gated on a built-in admin ROLE, not on a permission:
 * `agent:admin`, `skill:admin` and `project:admin` are oversight grants (see
 * the trash, restore from it), while destroying data past recovery is the
 * deployment owner's call. The routes answer 404 to everyone else, so this
 * cannot go through `PermissionButton` — no permission set describes the gate.
 */

/**
 * Row action for a trash view rendered with `TableRowActions`. Callers resolve
 * the role once in their component body (`useIsGlobalAdmin`) and pass it in,
 * rather than calling a hook inside a table cell renderer.
 *
 * `disabledReason` is for an entity-specific refusal the API would answer
 * anyway (a built-in skill, say) and takes precedence over the role gate: a
 * user who cannot act on the row at all should be told why, not sent to find
 * an admin who would hit the same wall.
 */
export function permanentDeleteRowAction({
  isGlobalAdmin,
  onClick,
  disabledReason,
}: {
  isGlobalAdmin: boolean;
  onClick: () => void;
  disabledReason?: string;
}): TableRowAction {
  const reason =
    disabledReason ?? (isGlobalAdmin ? undefined : PERMANENT_DELETE_ADMIN_ONLY);
  return {
    icon: <Trash2 className="h-4 w-4" />,
    label: PERMANENT_DELETE_LABEL,
    variant: "destructive",
    disabled: !!reason,
    disabledTooltip: reason,
    onClick,
  };
}

/**
 * The same action as an icon button, for the trash rows that render a
 * `ButtonGroup` of `PermissionButton`s (MCP gateways, LLM proxies) rather than
 * a `TableRowActions` list.
 */
export function PermanentDeleteButton({
  onClick,
  itemName,
}: {
  onClick: () => void;
  /**
   * Appended to the accessible name so screen reader users can tell one row's
   * button from the next, matching `TableRowActions`.
   */
  itemName?: string;
}) {
  const { isGlobalAdmin } = useIsGlobalAdmin();
  const label = itemName
    ? `${PERMANENT_DELETE_LABEL} ${itemName}`
    : PERMANENT_DELETE_LABEL;

  const button = (
    <Button
      aria-label={label}
      variant="outline"
      size="icon-sm"
      disabled={!isGlobalAdmin}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <Trash2 className="h-4 w-4 text-destructive" />
    </Button>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {isGlobalAdmin ? (
          button
        ) : (
          // A disabled button swallows pointer events, so the tooltip naming
          // the reason would never open. The span receives them instead — the
          // same trick `PermissionButton` and `TableRowActions` use.
          <span className="inline-flex cursor-not-allowed">{button}</span>
        )}
      </TooltipTrigger>
      <TooltipContent className="max-w-60">
        {isGlobalAdmin ? PERMANENT_DELETE_LABEL : PERMANENT_DELETE_ADMIN_ONLY}
      </TooltipContent>
    </Tooltip>
  );
}

// === internal ===

const PERMANENT_DELETE_LABEL = "Delete permanently";

const PERMANENT_DELETE_ADMIN_ONLY =
  "Only an Admin or Platform Admin can permanently delete";
