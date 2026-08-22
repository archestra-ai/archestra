import type { Permissions } from "@archestra/shared";
import { MoreHorizontal } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { formatPermissionConstraint } from "@/lib/auth/auth.utils";

type TableRowAction = {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  permissions?: Permissions | Readonly<Record<string, readonly string[]>>;
  disabled?: boolean;
  disabledTooltip?: string;
  /**
   * Explains what the action does when it IS available — for actions whose
   * label names the verb but not the consequence. The label alone remains the
   * tooltip when this is unset, so existing actions are unaffected.
   */
  tooltip?: string;
  variant?: "default" | "destructive";
  href?: string;
  /** The href leaves the app: open it in a new tab, as a link out should. */
  external?: boolean;
  testId?: string;
};

type TableRowActionsProps = {
  actions: TableRowAction[];
  dropdownActions?: TableRowAction[];
  size?: "sm" | "default";
  /**
   * Name of the row's item (e.g. the agent or skill name). Appended to each
   * action's accessible name so screen reader users can tell identical
   * buttons apart across rows ("Edit My Agent" vs. a column of "Edit"s).
   */
  itemName?: string;
};

export function TableRowActions({
  actions,
  dropdownActions,
  size = "sm",
  itemName,
}: TableRowActionsProps) {
  const buttonSize = size === "sm" ? "icon-sm" : "icon";

  return (
    <div className="flex">
      <ButtonGroup>
        {actions.map((action) => (
          <ActionButton
            key={action.label}
            action={action}
            size={buttonSize}
            itemName={itemName}
          />
        ))}
        {dropdownActions && dropdownActions.length > 0 && (
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size={buttonSize}
                    aria-label={accessibleActionLabel("More actions", itemName)}
                    onClick={(e: React.MouseEvent) => e.stopPropagation()}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>More actions</TooltipContent>
            </Tooltip>
            <DropdownMenuContent
              align="end"
              onClick={(e: React.MouseEvent) => e.stopPropagation()}
            >
              {dropdownActions.map((action) => (
                <DropdownActionButton key={action.label} action={action} />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </ButtonGroup>
    </div>
  );
}

function ActionButton({
  action,
  size,
  itemName,
}: {
  action: TableRowAction;
  size: "icon-sm" | "icon";
  itemName?: string;
}) {
  const icon =
    action.variant === "destructive" ? (
      <span className="text-destructive">{action.icon}</span>
    ) : (
      action.icon
    );

  const accessibleLabel = accessibleActionLabel(action.label, itemName);

  const tooltipText =
    action.disabled && action.disabledTooltip
      ? action.disabledTooltip
      : (action.tooltip ?? action.label);

  // PermissionButton handles its own tooltip (including "no permission" tooltip),
  // so we only wrap non-permission buttons in Tooltip
  if (action.permissions) {
    if (action.href && !action.disabled) {
      return (
        <PermissionButton
          permissions={action.permissions as Permissions}
          tooltip={tooltipText}
          aria-label={accessibleLabel}
          variant="outline"
          size={size}
          asChild
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
          data-testid={action.testId}
        >
          <Link href={action.href} {...externalLinkProps(action)}>
            {icon}
          </Link>
        </PermissionButton>
      );
    }

    return (
      <PermissionButton
        permissions={action.permissions as Permissions}
        tooltip={tooltipText}
        aria-label={accessibleLabel}
        variant="outline"
        size={size}
        disabled={action.disabled}
        data-testid={action.testId}
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          action.onClick?.();
        }}
      >
        {icon}
      </PermissionButton>
    );
  }

  // Non-permission buttons: always wrap in Tooltip
  const button =
    action.href && !action.disabled ? (
      <Button
        variant="outline"
        size={size}
        aria-label={accessibleLabel}
        asChild
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
        data-testid={action.testId}
      >
        <Link href={action.href} {...externalLinkProps(action)}>
          {icon}
        </Link>
      </Button>
    ) : (
      <Button
        aria-label={accessibleLabel}
        variant="outline"
        size={size}
        disabled={action.disabled}
        data-testid={action.testId}
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          action.onClick?.();
        }}
      >
        {icon}
      </Button>
    );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {action.disabled ? (
          // A disabled button swallows pointer events, so the tooltip (the
          // disabled reason) would never open. The span receives them
          // instead — same trick as PermissionButton; ButtonGroup's `>*`
          // selectors keep the grouped-border styling intact.
          <span className="inline-flex cursor-not-allowed">{button}</span>
        ) : (
          button
        )}
      </TooltipTrigger>
      <TooltipContent>{tooltipText}</TooltipContent>
    </Tooltip>
  );
}

function DropdownActionButton({ action }: { action: TableRowAction }) {
  const { data: hasPermission } = useHasPermissions(
    (action.permissions as Permissions) || {},
  );
  const reasonId = useId();

  const isPermitted = action.permissions ? hasPermission : true;

  // Why the action is refused, when it is. Kept apart from the caller's own
  // tooltip: a refusal must win over decorative hover text, and only a refusal
  // is announced as the control's description.
  let reason: string | undefined;
  if (action.permissions && !hasPermission) {
    reason = formatPermissionConstraint(action.permissions as Permissions);
  } else if (action.disabled && action.disabledTooltip) {
    reason = action.disabledTooltip;
  }

  const tooltipText = reason ?? action.tooltip ?? action.label;
  const isDisabled = action.disabled || !isPermitted;

  const icon =
    action.variant === "destructive" ? (
      <span className="text-destructive">{action.icon}</span>
    ) : (
      action.icon
    );

  const content = (
    // `aria-disabled` rather than Radix's `disabled`: a disabled item is taken
    // out of the menu's roving focus and typeahead, so the reason below would
    // be unreachable by exactly the users it is written for. The refusal is
    // enforced by preventing the select and the click instead.
    <DropdownMenuItem
      aria-disabled={isDisabled || undefined}
      variant={action.variant}
      className={
        isDisabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
      }
      onSelect={(e) => {
        if (isDisabled) {
          e.preventDefault();
        }
      }}
      onClick={(e) => {
        if (isDisabled) {
          e.preventDefault();
          return;
        }
        if (action.onClick) {
          action.onClick();
        }
      }}
      data-testid={action.testId}
      asChild={!!action.href && !isDisabled}
      aria-describedby={reason ? reasonId : undefined}
    >
      {action.href && !isDisabled ? (
        <Link href={action.href} {...externalLinkProps(action)}>
          {icon}
          {action.label}
        </Link>
      ) : (
        <>
          {icon}
          {action.label}
          {/* The reason as text, not only as a tooltip: a menu item reached by
              keyboard never opens one. `aria-hidden` keeps it out of the
              accessible name, where it would duplicate the description a
              screen reader already reads from `aria-describedby`. */}
          {reason && (
            <span id={reasonId} aria-hidden="true" className="sr-only">
              {reason}
            </span>
          )}
        </>
      )}
    </DropdownMenuItem>
  );

  if (tooltipText !== action.label) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {isDisabled ? (
            // A disabled item swallows pointer events, so the tooltip (the
            // disabled reason) would never open without this wrapper.
            <div className="cursor-not-allowed">{content}</div>
          ) : (
            // An enabled item triggers the tooltip itself: an extra element
            // between DropdownMenuContent and its item is what the disabled
            // branch can afford (disabled items are skipped by keyboard
            // navigation) and an enabled one cannot.
            content
          )}
        </TooltipTrigger>
        {/* `w-fit` with no bound renders a sentence as one long line that
            blankets the table beside the menu. Cap it so it wraps into a
            normal tooltip box. */}
        <TooltipContent side="left" className="max-w-64">
          {tooltipText}
        </TooltipContent>
      </Tooltip>
    );
  }

  return content;
}

function externalLinkProps(action: TableRowAction) {
  return action.external
    ? ({ target: "_blank", rel: "noreferrer" } as const)
    : {};
}

function accessibleActionLabel(label: string, itemName?: string) {
  return itemName ? `${label} ${itemName}` : label;
}

export type { TableRowAction, TableRowActionsProps };
