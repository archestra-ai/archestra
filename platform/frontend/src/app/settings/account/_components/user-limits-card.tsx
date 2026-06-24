import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useSession } from "@/lib/auth/auth.query";
import { useLimits } from "@/lib/limits.query";

export function UserLimitsCard() {
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

  const { data: limits = [], isPending } = useLimits({
    entityType: "user",
    entityId: currentUserId,
  });

  if (isPending || limits.length === 0) {
    return null;
  }

  const formatCurrency = (val: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 4,
    }).format(val);

  return (
    <Card>
      <CardHeader>
        <CardTitle>My Limits</CardTitle>
        <CardDescription>View your current usage and limits.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
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
                <span className="font-medium">
                  {getLimitTypeName(limit.limitType)}
                </span>
                <span className="text-muted-foreground">
                  {formatLimitValue(usage)} /{" "}
                  {formatLimitValue(limit.limitValue)}
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
      </CardContent>
    </Card>
  );
}
