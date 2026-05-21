"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/auth/auth.query";
import { useLimits, useMyDefaultLimitUsage } from "@/lib/limits.query";
import { useOrganization } from "@/lib/organization.query";

function formatCurrencyWhole(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatCurrencyFraction(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function getUsageStatus(percentage: number) {
  if (percentage >= 90) return "danger" as const;
  if (percentage >= 75) return "warning" as const;
  return "safe" as const;
}

function getProgressClass(status: ReturnType<typeof getUsageStatus>) {
  switch (status) {
    case "danger":
      return "bg-red-100";
    case "warning":
      return "bg-orange-100";
    default:
      return undefined;
  }
}

function getStatusLabel(status: ReturnType<typeof getUsageStatus>) {
  switch (status) {
    case "danger":
      return "Exceeded";
    case "warning":
      return "Near limit";
    default:
      return "Safe";
  }
}

function getStatusColorClass(status: ReturnType<typeof getUsageStatus>) {
  switch (status) {
    case "danger":
      return "text-red-600";
    case "warning":
      return "text-orange-600";
    default:
      return "text-muted-foreground";
  }
}

function formatLimitModels(models: string[] | null | undefined) {
  if (!models || models.length === 0) {
    return "All models";
  }
  return models.join(", ");
}

export function LimitUsageCard() {
  const { data: session } = useSession();
  const userId = session?.user?.id;
  const { data: organization } = useOrganization();

  const {
    data: userLimits = [],
    isPending: isUserLimitsPending,
    isLoading: isUserLimitsLoading,
  } = useLimits({
    entityType: "user",
    entityId: userId,
    limitType: "token_cost",
  });

  const {
    data: defaultUsage,
    isPending: isDefaultUsagePending,
    isLoading: isDefaultUsageLoading,
  } = useMyDefaultLimitUsage();

  const hasCustomUserLimits = userLimits.length > 0;
  const isLoading = isUserLimitsLoading || isDefaultUsageLoading;
  const isPending = isUserLimitsPending || isDefaultUsagePending;

  if (isLoading || isPending) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Usage Limits</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </CardContent>
      </Card>
    );
  }

  if (!hasCustomUserLimits && !defaultUsage) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage Limits</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {hasCustomUserLimits &&
          userLimits.map((limit) => {
            const actualUsage = (limit.modelUsage ?? []).reduce(
              (sum, usage) => sum + usage.cost,
              0,
            );
            const actualLimit = limit.limitValue;
            const percentage =
              actualLimit > 0 ? (actualUsage / actualLimit) * 100 : 0;
            const status = getUsageStatus(percentage);
            const remaining = Math.max(0, actualLimit - actualUsage);

            return (
              <div key={limit.id} className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Custom Limit</span>
                  <span
                    className={`text-xs font-medium ${getStatusColorClass(status)}`}
                  >
                    {getStatusLabel(status)}
                  </span>
                </div>
                <Progress
                  value={Math.min(percentage, 100)}
                  className={getProgressClass(status)}
                />
                <p className="text-xs text-muted-foreground">
                  {`${formatCurrencyFraction(actualUsage)} / ${formatCurrencyWhole(actualLimit)} (${percentage.toFixed(1)}%)`}
                  {remaining > 0 &&
                    ` · ${formatCurrencyFraction(remaining)} remaining`}
                </p>
                <p className="text-xs text-muted-foreground">
                  Models: {formatLimitModels(limit.model)}
                </p>
              </div>
            );
          })}

        {!hasCustomUserLimits && defaultUsage && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Default Limit</span>
              <span
                className={`text-xs font-medium ${getStatusColorClass(
                  getUsageStatus(
                    (defaultUsage.usage.cost / defaultUsage.limitValue) * 100,
                  ),
                )}`}
              >
                {getStatusLabel(
                  getUsageStatus(
                    (defaultUsage.usage.cost / defaultUsage.limitValue) * 100,
                  ),
                )}
              </span>
            </div>
            <Progress
              value={Math.min(
                (defaultUsage.usage.cost / defaultUsage.limitValue) * 100,
                100,
              )}
              className={getProgressClass(
                getUsageStatus(
                  (defaultUsage.usage.cost / defaultUsage.limitValue) * 100,
                ),
              )}
            />
            <p className="text-xs text-muted-foreground">
              {`${formatCurrencyFraction(defaultUsage.usage.cost)} / ${formatCurrencyWhole(defaultUsage.limitValue)} (${((defaultUsage.usage.cost / defaultUsage.limitValue) * 100).toFixed(1)}%)`}
              {` · ${formatCurrencyFraction(Math.max(0, defaultUsage.limitValue - defaultUsage.usage.cost))} remaining`}
            </p>
            <p className="text-xs text-muted-foreground">
              Models: {formatLimitModels(defaultUsage.models)}
            </p>
          </div>
        )}

        {organization?.defaultUserLimitValue && !hasCustomUserLimits && (
          <p className="text-xs text-muted-foreground">
            This is the default organization limit. Custom per-user limits can
            be configured by an administrator.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
