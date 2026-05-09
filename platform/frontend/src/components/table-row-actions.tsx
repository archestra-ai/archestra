import type { Permissions } from "@shared";
import { MoreHorizontal } from "lucide-react";
import Link from "next/link";
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
import {
  useHasPermissions,
  useMissingPermissions,
} from "@/lib/auth/auth.query";
import { formatMissingPermissions } from "@/lib/auth/auth.utils";

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
  dropdownActions?: TableRowAction[];
  size?: "sm" | "default";
};

export function TableRowActions({
  actions,
  dropdownActions,
  size = "sm",
}: TableRowActionsProps) {
  const buttonSize = size === "sm" ? "icon-sm" : "icon";

  return (
    <div className="flex">
      <ButtonGroup>
        {actions.map((action) => (
          <ActionButton key={action.label} action={action} size={buttonSize} />
        ))}
        {dropdownActions && dropdownActions.length > 0 && (
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size={buttonSize}
                    aria-label="More actions"
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

function DropdownActionButton({ action }: { action: TableRowAction }) {
  const { data: hasPermission } = useHasPermissions(
    (action.permissions as Permissions) || {},
  );
  const missingPermissions = useMissingPermissions(
    (action.permissions as Permissions) || {},
  );

  const isPermitted = action.permissions ? hasPermission : true;

  let tooltipText = action.label;
  if (action.permissions && !hasPermission) {
    tooltipText = formatMissingPermissions(missingPermissions);
  } else if (action.disabled && action.disabledTooltip) {
    tooltipText = action.disabledTooltip;
  }

  const isDisabled = action.disabled || !isPermitted;

  const icon =
    action.variant === "destructive" ? (
      <span className="text-destructive">{action.icon}</span>
    ) : (
      action.icon
    );

  const content = (
    <DropdownMenuItem
      disabled={isDisabled}
      variant={action.variant}
      className={isDisabled ? "cursor-not-allowed" : "cursor-pointer"}
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
    >
      {action.href && !isDisabled ? (
        <Link href={action.href}>
          {icon}
          {action.label}
        </Link>
      ) : (
        <>
          {icon}
          {action.label}
        </>
      )}
    </DropdownMenuItem>
  );

  if (isDisabled && tooltipText !== action.label) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="cursor-not-allowed">{content}</div>
        </TooltipTrigger>
        <TooltipContent side="left">{tooltipText}</TooltipContent>
      </Tooltip>
    );
  }

  return content;
}

export type { TableRowAction, TableRowActionsProps };
