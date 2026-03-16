"use client";

import { Shield } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type RoleTypeIconProps = {
  predefined: boolean;
  className?: string;
  withTooltip?: boolean;
};

type RoleOptionLabelProps = {
  predefined: boolean;
  label: string;
  className?: string;
  iconClassName?: string;
  withTooltip?: boolean;
};

export function RoleTypeIcon({
  predefined,
  className,
  withTooltip = false,
}: RoleTypeIconProps) {
  const icon = (
    <Shield
      className={cn(
        "h-4 w-4 shrink-0",
        predefined ? "text-primary" : "text-muted-foreground",
        className,
      )}
    />
  );

  if (!withTooltip) {
    return icon;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{icon}</TooltipTrigger>
      <TooltipContent>{predefined ? "Predefined" : "Custom"}</TooltipContent>
    </Tooltip>
  );
}

export function RoleOptionLabel({
  predefined,
  label,
  className,
  iconClassName,
  withTooltip = false,
}: RoleOptionLabelProps) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2", className)}>
      <RoleTypeIcon
        predefined={predefined}
        className={iconClassName}
        withTooltip={withTooltip}
      />
      <span className="min-w-0 truncate capitalize">{label}</span>
    </span>
  );
}
