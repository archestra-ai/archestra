"use client";
import { Check, HelpCircle, Minus, X } from "lucide-react";
import type { ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
export function McpCallIdentity({
  name,
  server,
  icon,
  status,
  method,
}: {
  name: ReactNode;
  server: ReactNode;
  icon: ReactNode;
  status: "success" | "error" | "cancelled" | "unknown";
  method: string;
}) {
  const Icon = {
    success: Check,
    error: X,
    cancelled: Minus,
    unknown: HelpCircle,
  }[status];
  const label = {
    success: "Success",
    error: "Error",
    cancelled: "Cancelled",
    unknown: "Outcome unavailable",
  }[status];
  const color =
    status === "success"
      ? "text-emerald-600 dark:text-emerald-400"
      : status === "error"
        ? "text-destructive"
        : "text-muted-foreground";
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="relative flex size-7 shrink-0 items-center justify-center rounded bg-muted/50 text-muted-foreground">
        {icon}
        <Tooltip>
          <TooltipTrigger asChild>
            <UnstyledButton
              aria-label={label}
              onClick={(e) => e.stopPropagation()}
              className={`absolute -bottom-0.5 -right-0.5 flex size-3.5 cursor-default items-center justify-center rounded-full bg-background ${color}`}
            >
              <Icon className="size-2.5" aria-hidden="true" />
            </UnstyledButton>
          </TooltipTrigger>
          <TooltipContent className="px-2 py-1 text-xs">{label}</TooltipContent>
        </Tooltip>
      </span>
      <div className="min-w-0">
        <div className="truncate font-mono text-xs font-medium">{name}</div>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="truncate">{server}</span>
          {method !== "tools/call" && (
            <span className="shrink-0 text-[10px]">{method}</span>
          )}
        </div>
      </div>
    </div>
  );
}
