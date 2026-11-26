import { Badge } from "@/components/ui/badge";
import type { AutoRouter } from "@/lib/auto-routing.query";
import { isAutoRoutingSetUp } from "./setup-cards";

type RouterStatusLabel =
  | "Active"
  | "Evaluating"
  | "Fit failed"
  | "Needs setup"
  | "Off";

const DOT: Record<RouterStatusLabel, string> = {
  Active: "size-2 rounded-full bg-emerald-500",
  Evaluating: "size-2 rounded-full bg-sky-500",
  "Fit failed": "size-2 rounded-full bg-destructive",
  "Needs setup": "size-2 rounded-full bg-amber-500",
  Off: "size-2 rounded-full border border-muted-foreground",
};

/**
 * Where a router stands. A router that can route is evaluating sessions until
 * it has a plan, which is why its figures are empty, unless its fit failed;
 * then it is active.
 */
export function routerStatus(router: AutoRouter): RouterStatusLabel {
  if (!isAutoRoutingSetUp(router)) {
    return router.enabled ? "Needs setup" : "Off";
  }
  if (router.status.activePlan) return "Active";
  return router.status.lastFitError ? "Fit failed" : "Evaluating";
}

type ColdStart = AutoRouter["status"]["coldStart"];

/** Where a router without a plan is: no sessions yet, gathering them, or past the minimum with its first fit to come. */
export function coldStartState({
  sessions,
  required,
}: ColdStart): "waiting" | "learning" | "building" {
  if (sessions === 0) return "waiting";
  return sessions < required ? "learning" : "building";
}

/** "N / required sessions", and how many of them are past sessions when those count. */
export function coldStartProgress({
  sessions,
  required,
  pastSessions,
}: ColdStart): string {
  const progress = `${count(sessions)} / ${count(required)} sessions`;
  return pastSessions > 0
    ? `${progress}, including ${count(pastSessions)} past sessions`
    : progress;
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

export function RouterStatus({ label }: { label: RouterStatusLabel }) {
  return (
    <Badge variant="outline" data-testid="auto-routing-header-status">
      <span aria-hidden className={DOT[label]} />
      <span>{label}</span>
    </Badge>
  );
}
