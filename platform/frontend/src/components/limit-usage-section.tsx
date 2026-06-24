import type { archestraApiTypes } from "@archestra/shared";
import { Progress } from "@/components/ui/progress";
import { useLimits } from "@/lib/limits.query";

type LimitEntityType = archestraApiTypes.CreateLimitData["body"]["entityType"];

import { Label } from "@/components/ui/label";

export function LimitUsageSection({
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
    return (
      <div className="space-y-2">
        <Label>Usage Limits</Label>
        <div className="w-full h-4 bg-muted animate-pulse rounded" />
      </div>
    );
  }

  if (limits.length === 0) {
    return null;
  }

  const formatCurrency = (val: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 4,
    }).format(val);

  return (
    <div className="space-y-3">
      <Label>Usage Limits</Label>
      <div className="space-y-4 border rounded-md p-4 bg-muted/20">
        {limits.map((limit) => {
          const isTokenCost = limit.limitType === "token_cost";
          const usage = isTokenCost
            ? (limit.modelUsage?.reduce((acc, curr) => acc + curr.cost, 0) ?? 0)
            : 0; // TODO: Implement usage extraction for other limit types
          const usagePercentage =
            limit.limitValue > 0 ? (usage / limit.limitValue) * 100 : 100;
          const isDanger = usagePercentage >= 100;
          const isWarning = usagePercentage >= 90 && usagePercentage < 100;

          const formatLimitValue = (val: number) => {
            if (isTokenCost) return formatCurrency(val);
            return val.toString();
          };

          const getLimitTypeName = (type: string) => {
            switch (type) {
              case "token_cost":
                return "Token Cost";
              case "mcp_server_calls":
                return "MCP Server Calls";
              case "tool_calls":
                return "Tool Calls";
              default:
                return "Unknown Limit";
            }
          };

          return (
            <div key={limit.id} className="space-y-2">
              <div className="flex justify-between items-center text-sm">
                <span className="font-medium text-muted-foreground">
                  {getLimitTypeName(limit.limitType)}
                </span>
                <span className="text-muted-foreground text-xs">
                  {formatLimitValue(usage)} /{" "}
                  {formatLimitValue(limit.limitValue)} (
                  {usagePercentage.toFixed(1)}%)
                </span>
              </div>
              <Progress
                value={Math.min(usagePercentage, 100)}
                indicatorClassName={
                  isDanger
                    ? "bg-red-500"
                    : isWarning
                      ? "bg-orange-500"
                      : undefined
                }
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
