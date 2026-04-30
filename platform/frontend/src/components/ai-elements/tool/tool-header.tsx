"use client";

import type { ToolUIPart } from "ai";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export type ToolHeaderProps = {
  title?: string;
  type: ToolUIPart["type"];
  state: ToolUIPart["state"] | "output-available-dual-llm" | "output-denied";
  className?: string;
  icon?: ReactNode;
  isCollapsible?: boolean;
  /** Optional action button to display in the header (e.g., View Logs) */
  actionButton?: ReactNode;
};

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  icon,
  isCollapsible = true,
  actionButton,
  ...props
}: ToolHeaderProps) => (
  <CollapsibleTrigger
    className={cn(
      "flex w-full items-center justify-between gap-4 p-3 cursor-pointer group",
      isCollapsible ? "cursor-pointer" : "!cursor-default",
      className,
    )}
    {...props}
  >
    <div className="flex-1">
      <div className="flex items-center gap-2">
        {icon ?? <WrenchIcon className="size-4 text-muted-foreground" />}
        <span className="font-medium text-sm">
          {title ?? type.split("-").slice(1).join("-")}
        </span>
        {getStatusBadge(state)}
      </div>
    </div>
    {actionButton && (
      // biome-ignore lint/a11y/noStaticElementInteractions: Wrapper needs to stop event propagation
      <div
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {actionButton}
      </div>
    )}
    {isCollapsible && (
      <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
    )}
  </CollapsibleTrigger>
);

function getStatusBadge(
  status: ToolUIPart["state"] | "output-available-dual-llm" | "output-denied",
) {
  const labels = {
    "input-streaming": "Pending",
    "input-available": "Running",
    "approval-requested": "Approval Requested",
    "approval-responded": "Approval Responded",
    "output-available": "Completed",
    "output-available-dual-llm": "Completed with dual LLM",
    "output-error": "Error",
    "output-denied": "Denied",
  } as const;

  const icons = {
    "input-streaming": <CircleIcon className="size-4" />,
    "input-available": <ClockIcon className="size-4 animate-pulse" />,
    "approval-requested": <ClockIcon className="size-4 text-yellow-600" />,
    "approval-responded": <CheckCircleIcon className="size-4 text-blue-600" />,
    "output-available": <CheckCircleIcon className="size-4 text-green-600" />,
    "output-available-dual-llm": (
      <CheckCircleIcon className="size-4 text-green-600" />
    ),
    "output-error": <XCircleIcon className="size-4 text-destructive" />,
    "output-denied": <XCircleIcon className="size-4 text-orange-600" />,
  } as const;

  return (
    <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
      {icons[status]}
      {labels[status]}
    </Badge>
  );
}
