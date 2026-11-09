import { Badge } from "@/components/ui/badge";
import type { AutoRouter } from "@/lib/auto-routing.query";
import { isAutoRoutingSetUp } from "./setup-cards";

type RouterStatusLabel = "On" | "Needs setup" | "Off";

/** On, off, or still being set up. */
export function routerStatus(router: AutoRouter): RouterStatusLabel {
  return isAutoRoutingSetUp(router)
    ? "On"
    : router.enabled
      ? "Needs setup"
      : "Off";
}

export function RouterStatus({ label }: { label: RouterStatusLabel }) {
  return (
    <Badge variant="outline" data-testid="auto-routing-header-status">
      <span
        aria-hidden
        className={
          label === "On"
            ? "size-2 rounded-full bg-emerald-500"
            : label === "Off"
              ? "size-2 rounded-full border border-muted-foreground"
              : "size-2 rounded-full bg-amber-500"
        }
      />
      <span>{label}</span>
    </Badge>
  );
}
