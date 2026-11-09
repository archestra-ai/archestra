import { Badge } from "@/components/ui/badge";
import type { AutoRouter } from "@/lib/auto-routing.query";
import { isAutoRoutingSetUp } from "./setup-cards";

type RouterStatusLabel = "Active" | "Evaluating" | "Needs setup" | "Off";

const DOT: Record<RouterStatusLabel, string> = {
  Active: "size-2 rounded-full bg-emerald-500",
  Evaluating: "size-2 rounded-full bg-sky-500",
  "Needs setup": "size-2 rounded-full bg-amber-500",
  Off: "size-2 rounded-full border border-muted-foreground",
};

/**
 * Where a router stands. A router that can route is evaluating sessions until
 * it has a plan, which is why its figures are empty; then it is active.
 */
export function routerStatus(router: AutoRouter): RouterStatusLabel {
  if (!isAutoRoutingSetUp(router)) {
    return router.enabled ? "Needs setup" : "Off";
  }
  return router.status.activePlan ? "Active" : "Evaluating";
}

export function RouterStatus({ label }: { label: RouterStatusLabel }) {
  return (
    <Badge variant="outline" data-testid="auto-routing-header-status">
      <span aria-hidden className={DOT[label]} />
      <span>{label}</span>
    </Badge>
  );
}
