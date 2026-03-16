import type { Permissions } from "@shared";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type TableRowAction = {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  permissions?: Permissions | Readonly<Record<string, readonly string[]>>;
  disabled?: boolean;
  disabledTooltip?: string;
  variant?: "default" | "destructive";
  href?: string;
  testId?: string;
};

type TableRowActionsProps = {
  actions: TableRowAction[];
  size?: "sm" | "default";
};

export function TableRowActions({
  actions,
  size = "sm",
}: TableRowActionsProps) {
  const buttonSize = size === "sm" ? "icon-sm" : "icon";

  return (
    <div className="flex">
      <ButtonGroup>
        {actions.map((action) => (
          <ActionButton key={action.label} action={action} size={buttonSize} />
        ))}
      </ButtonGroup>
    </div>
  );
}

function ActionButton({
  action,
  size,
}: {
  action: TableRowAction;
  size: "icon-sm" | "icon";
}) {
  const icon =
    action.variant === "destructive" ? (
      <span className="text-destructive">{action.icon}</span>
    ) : (
      action.icon
    );

  const tooltipText =
    action.disabled && action.disabledTooltip
      ? action.disabledTooltip
      : action.label;

  // PermissionButton handles its own tooltip (including "no permission" tooltip),
  // so we only wrap non-permission buttons in Tooltip
  if (action.permissions) {
    if (action.href && !action.disabled) {
      return (
        <PermissionButton
          permissions={action.permissions as Permissions}
          tooltip={tooltipText}
          aria-label={action.label}
          variant="outline"
          size={size}
          asChild
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
          data-testid={action.testId}
        >
          <Link href={action.href}>{icon}</Link>
        </PermissionButton>
      );
    }

    return (
      <PermissionButton
        permissions={action.permissions as Permissions}
        tooltip={tooltipText}
        aria-label={action.label}
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
        aria-label={action.label}
        asChild
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
        data-testid={action.testId}
      >
        <Link href={action.href}>{icon}</Link>
      </Button>
    ) : (
      <Button
        aria-label={action.label}
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
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{tooltipText}</TooltipContent>
    </Tooltip>
  );
}

export type { TableRowAction, TableRowActionsProps };
