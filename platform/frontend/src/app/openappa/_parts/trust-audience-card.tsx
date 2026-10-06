"use client";

import { Info, MessageCircle } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { QueryLoadError } from "@/components/query-load-error";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import { useBatteries } from "@/lib/openappa-batteries.query";
import {
  type AudienceLevel,
  useTrustAudience,
} from "@/lib/openappa-trust-audience.query";
import { cn } from "@/lib/utils/tailwind";
import { batteryDisplayName } from "./battery-display-name";
import { BatteryIcon } from "./battery-icon";
import { OpenAppaChatButton } from "./openappa-chat-button";

/** The Overview's trust chain, and its audiences nested by containment. */
export function TrustAudienceCard() {
  const view = useTrustAudience();

  return (
    <Card className="gap-5 py-5">
      <CardHeader className="px-5">
        <CardTitle>Security label</CardTitle>
        <CardDescription>
          Each agent session has a security label — its audience and trust. It
          determines what the agent can do, based on the data it has read.
        </CardDescription>
        <CardAction>
          <OpenAppaChatButton
            size="sm"
            variant="outline"
            promptKey="explainSecurityLabel"
          >
            <MessageCircle />
            <span>Ask about the security label</span>
          </OpenAppaChatButton>
        </CardAction>
      </CardHeader>
      <CardContent className="px-5">
        {view.isLoadingError ? (
          <QueryLoadError
            title="Could not load trust and audience"
            onRetry={() => view.refetch()}
          />
        ) : !view.data ? (
          <Skeleton className="h-52 w-full" />
        ) : (
          <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-4 gap-y-5 text-sm">
            <Term hint="Text written by an outsider, such as a web page, lowers it, and it never rises again in the session.">
              Trust
            </Term>
            <dd>
              <TrustScale levels={view.data.trust} />
            </dd>
            <Term
              className="pt-3"
              hint="Reading something private limits where the agent can send it."
            >
              Audience
            </Term>
            <dd>
              <AudienceNest audiences={view.data.audiences} />
            </dd>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

// =============================================================================
// Internal components
// =============================================================================

function Term({
  hint,
  className,
  children,
}: {
  hint: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <dt
      className={cn(
        "flex items-start gap-1 text-xs font-medium text-muted-foreground",
        className,
      )}
    >
      <span>{children}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`About ${String(children).toLowerCase()}`}
            className="mt-px hover:text-foreground"
          >
            <Info className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{hint}</TooltipContent>
      </Tooltip>
    </dt>
  );
}

/**
 * The trust chain as a scale, most trusted first: each segment is colored by
 * its rank, from green at the top to red at the lowest.
 */
function TrustScale({ levels }: { levels: string[] }) {
  const ranks = [...levels].reverse();
  return (
    <div
      className="grid max-w-lg gap-x-1 gap-y-1.5"
      style={{ gridTemplateColumns: `repeat(${ranks.length}, minmax(0, 1fr))` }}
    >
      {ranks.map((name, index) => (
        <span
          key={name}
          aria-hidden="true"
          className="h-1.5 rounded-full"
          style={{ backgroundColor: rankColor(index, ranks.length) }}
        />
      ))}
      {ranks.map((name) => (
        <span key={name} className="truncate font-mono text-xs">
          {name}
        </span>
      ))}
    </div>
  );
}

/** Green for the most trusted rank, red for the least, evenly between. */
function rankColor(index: number, count: number): string {
  const towardRed = count === 1 ? 0 : Math.round((index / (count - 1)) * 100);
  return `color-mix(in oklch, var(--color-red-500) ${towardRed}%, var(--color-emerald-500))`;
}

/**
 * `public` ⊇ `internal` ⊇ `self` as surfaces stacked inside each other; each
 * group sits inside the level it is declared `within`.
 */
function AudienceNest({ audiences }: { audiences: AudienceLevel[] }) {
  const level = (name: string) => audiences.find((each) => each.name === name);
  const groupsWithin = (name: string) =>
    audiences
      .filter(
        (each) =>
          each.kind === "mapped" &&
          each.name.startsWith("@") &&
          (each.within ?? "public") === name,
      )
      .map((group) => (
        <LevelBox key={group.name} level={group} className={INNER_SURFACE} />
      ));
  const publicLevel = level("public");
  const internal = level("internal");
  const self = level("self");
  if (!publicLevel || !internal || !self) return null;

  return (
    <LevelBox level={publicLevel} className="bg-muted/60">
      <LevelBox
        level={internal}
        className="bg-muted/40 shadow-xs ring-1 ring-foreground/5"
      >
        {groupsWithin("internal")}
        <LevelBox level={self} className={INNER_SURFACE}>
          {groupsWithin("self")}
        </LevelBox>
      </LevelBox>
      {groupsWithin("public")}
    </LevelBox>
  );
}

const INNER_SURFACE = "bg-card shadow-xs ring-1 ring-foreground/5";

function LevelBox({
  level,
  className,
  children,
}: {
  level: AudienceLevel;
  className: string;
  children?: ReactNode;
}) {
  const nested = Array.isArray(children)
    ? children.flat().some(Boolean)
    : Boolean(children);
  const batteries =
    level.kind === "mapped"
      ? [
          ...new Set(
            level.from.flatMap((ref) =>
              ref.declaredBy ? [ref.declaredBy.battery] : [],
            ),
          ),
        ]
      : [];
  return (
    <div className={cn("rounded-lg p-3", className)}>
      <div className="flex min-h-7 items-center gap-3">
        <span className="font-mono font-medium">{level.name}</span>
        {batteries.length > 0 && (
          <span className="flex items-center gap-1">
            {batteries.map((battery) => (
              <BatteryLink key={battery} battery={battery} />
            ))}
          </span>
        )}
      </div>
      {nested && <div className="mt-3 space-y-2">{children}</div>}
    </div>
  );
}

/** A battery an audience reads members from, as its icon; it names that battery on hover and opens it. */
function BatteryLink({ battery }: { battery: string }) {
  const batteries = useBatteries();
  const catalog = useInternalMcpCatalog();
  const summary = batteries.data?.find((each) => each.name === battery);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={`/openappa/batteries?${new URLSearchParams({ battery })}`}
          aria-label={`Open the ${battery} battery`}
          className="flex size-7 items-center justify-center rounded-md border bg-background transition-colors hover:bg-muted"
        >
          <BatteryIcon
            name={battery}
            bundled={summary?.source === "bundled"}
            catalogIds={
              summary?.installs.map((install) => install.catalogId) ?? []
            }
            catalog={catalog.data ?? []}
            size={16}
          />
        </Link>
      </TooltipTrigger>
      <TooltipContent>
        <span>{batteryDisplayName(battery)}</span>
      </TooltipContent>
    </Tooltip>
  );
}
