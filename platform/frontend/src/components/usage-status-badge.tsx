"use client";

import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Progress,
} from "@/components/ui/progress";
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

interface UsageProgressBarProps {
  entityType: "agent" | "virtual_key" | "team" | "llm_proxy" | "organization" | "user";
  entityId: string;
  compact?: boolean;
}

export function UsageProgressBar({
  entityType,
  entityId,
  compact = false,
}: UsageProgressBarProps) {
  const { data: limits } = useLimits();

  const entityLimits = (limits ?? []).filter(
    (limit: { entityType: string; entityId: string; limitType: string }) =>
      limit.entityType === entityType &&
      limit.entityId === entityId &&
      limit.limitType === "token_cost",
  );

  if (entityLimits.length === 0) return null;

  const mostRestrictiveLimit = entityLimits.reduce<
    (typeof entityLimits)[number] | null
  >((worst, limit) => {
    const usage = (limit.modelUsage ?? []).reduce(
      (sum, u) => sum + u.cost,
      0,
    );
    const pct = limit.limitValue > 0 ? usage / limit.limitValue : 0;
    if (!worst) return limit;
    const worstUsage = (worst.modelUsage ?? []).reduce(
      (sum, u) => sum + u.cost,
      0,
    );
    const worstPct =
      worst.limitValue > 0 ? worstUsage / worst.limitValue : 0;
    return pct > worstPct ? limit : worst;
  }, null);

  if (!mostRestrictiveLimit) return null;

  const actualUsage = (mostRestrictiveLimit.modelUsage ?? []).reduce(
    (sum, u) => sum + u.cost,
    0,
  );
  const actualLimit = mostRestrictiveLimit.limitValue;
  const percentage = actualLimit > 0 ? (actualUsage / actualLimit) * 100 : 0;
  const clampedPercentage = Math.min(percentage, 100);

  const status: UsageStatus =
    percentage >= 90 ? "danger" : percentage >= 75 ? "warning" : "safe";

  const formatCurrency = (v: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(v);

  if (compact) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-1.5">
              <Progress
                value={clampedPercentage}
                className="h-1.5 w-16"
              />
              <span
                className={`text-[10px] font-medium ${
                  status === "danger"
                    ? "text-red-600"
                    : status === "warning"
                      ? "text-orange-500"
                      : "text-muted-foreground"
                }`}
              >
                {Math.round(percentage)}%
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent>
            <p>
              {formatCurrency(actualUsage)} / {formatCurrency(actualLimit)}{" "}
              ({percentage.toFixed(1)}%)
            </p>
            <p className="text-xs text-muted-foreground">
              {status === "danger"
                ? "Usage limit exceeded"
                : status === "warning"
                  ? "Approaching usage limit"
                  : "Usage within limits"}
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="w-full max-w-[200px]">
            <Progress
              value={clampedPercentage}
              className={
                status === "danger"
                  ? "bg-red-100"
                  : status === "warning"
                    ? "bg-orange-100"
                    : undefined
              }
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {formatCurrency(actualUsage)} / {formatCurrency(actualLimit)} (
              {percentage.toFixed(1)}%)
            </p>
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
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
