"use client";

import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useLimits } from "@/lib/limits.query";

type UsageStatus = "danger" | "warning" | "safe";

interface UsageStatusBadgeProps {
  entityType: "agent" | "virtual_key" | "team" | "llm_proxy";
  entityId: string;
}

function getUsageStatus(
  limits: { modelUsage: { cost: number }[]; limitValue: number }[],
): { status: UsageStatus; maxPercentage: number } {
  let maxPercentage = 0;
  for (const limit of limits) {
    const actualUsage = (limit.modelUsage ?? []).reduce(
      (sum, usage) => sum + usage.cost,
      0,
    );
    const actualLimit = limit.limitValue;
    const percentage = actualLimit > 0 ? (actualUsage / actualLimit) * 100 : 0;
    maxPercentage = Math.max(maxPercentage, percentage);
  }

  if (maxPercentage >= 90) return { status: "danger", maxPercentage };
  if (maxPercentage >= 75) return { status: "warning", maxPercentage };
  return { status: "safe", maxPercentage };
}

export function UsageStatusBadge({
  entityType,
  entityId,
}: UsageStatusBadgeProps) {
  const { data: limits } = useLimits();

  const entityLimits = (limits ?? []).filter(
    (limit: { entityType: string; entityId: string }) =>
      limit.entityType === entityType && limit.entityId === entityId,
  );

  if (entityLimits.length === 0) return null;

  const { status, maxPercentage } = getUsageStatus(entityLimits);

  const variant =
    status === "danger"
      ? "destructive"
      : status === "warning"
        ? "secondary"
        : "outline";

  const icon =
    status === "danger" ? (
      <XCircle className="h-3 w-3" />
    ) : status === "warning" ? (
      <AlertTriangle className="h-3 w-3" />
    ) : (
      <CheckCircle2 className="h-3 w-3" />
    );

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div>
            <Badge variant={variant} className="gap-1 text-xs">
              {icon}
              {Math.round(maxPercentage)}%
            </Badge>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <p>
            {status === "danger"
              ? "Usage limit exceeded"
              : status === "warning"
                ? "Approaching usage limit"
                : "Usage within limits"}
          </p>
          <p className="text-xs text-muted-foreground">
            {entityLimits.length} limit{entityLimits.length > 1 ? "s" : ""}{" "}
            configured
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
