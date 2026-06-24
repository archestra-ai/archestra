import type { archestraApiTypes } from "@archestra/shared";
import { Progress } from "@/components/ui/progress";
import { useLimits } from "@/lib/limits.query";

type LimitEntityType = archestraApiTypes.CreateLimitData["body"]["entityType"];
export function LimitUsageCell({
  entityType,
  entityId,
}: {
  entityType: LimitEntityType;
  entityId: string;
}) {
  const { data: limits = [], isPending } = useLimits({
    entityType,
    entityId,
  });

  if (isPending) {
    return <div className="w-[120px] h-4 bg-muted animate-pulse rounded" />;
  }

  if (limits.length === 0) {
    return <div className="text-sm text-muted-foreground">No limit</div>;
  }

  // Find the most restrictive limit
  const limitWithUsage = limits
    .map((limit) => {
      const isTokenCost = limit.limitType === "token_cost";
      const usage = isTokenCost
        ? (limit.modelUsage?.reduce((acc, curr) => acc + curr.cost, 0) ?? 0)
        : 0; // TODO: Implement usage extraction for other limit types
      const usagePercentage =
        limit.limitValue > 0 ? (usage / limit.limitValue) * 100 : 100;
      return { limit, isTokenCost, usage, usagePercentage };
    })
    .sort((a, b) => b.usagePercentage - a.usagePercentage)[0];

  const { limit, isTokenCost, usage, usagePercentage } = limitWithUsage;

  const isDanger = usagePercentage >= 100;
  const isWarning = usagePercentage >= 90 && usagePercentage < 100;

  const formatLimitValue = (val: number) => {
    if (isTokenCost) {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      }).format(val);
    }
    return val.toString();
  };

  return (
    <div className="w-[160px]">
      <Progress
        value={Math.min(usagePercentage, 100)}
        indicatorClassName={
          isDanger ? "bg-red-500" : isWarning ? "bg-orange-500" : undefined
        }
      />
      <p className="mt-1 text-left text-xs text-muted-foreground">
        {`${formatLimitValue(usage)} / ${formatLimitValue(limit.limitValue)} (${usagePercentage.toFixed(1)}%)`}
      </p>
    </div>
  );
}
