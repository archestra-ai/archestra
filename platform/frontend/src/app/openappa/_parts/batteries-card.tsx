"use client";

import { ChevronRight, MessageCircle } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useBatteries } from "@/lib/openappa-batteries.query";
import type { CoverageSummary } from "@/lib/openappa-coverage.query";
import { openAppaChatHref } from "@/lib/openappa-routes";
import { batteryDisplayName } from "./battery-display-name";
import {
  BATTERY_STATUS,
  type BatteryStatusGroup,
  batteriesHref,
} from "./battery-status";
import { RULE_BUCKETS } from "./rule-coverage-bar";

type Batteries = CoverageSummary["batteries"];

const color = (key: (typeof RULE_BUCKETS)[number]["key"]) =>
  RULE_BUCKETS.find((bucket) => bucket.key === key)?.color;
// Active and broken batteries take the colors of the tools they judge.
const ACTIVE_COLOR = color("battery");
const BROKEN_COLOR = color("notEnforced");
/** Tools an available battery would judge: covered once it is installed. */
const AVAILABLE_FILL = `repeating-linear-gradient(135deg, ${ACTIVE_COLOR} 0 2px, transparent 2px 5px)`;

/** How many batteries a tooltip names before it only counts the rest. */
const NAMED = 8;

const share = (count: number, of: number) => Math.round((count / of) * 100);
const tools = (count: number) =>
  `${count.toLocaleString()} ${count === 1 ? "tool" : "tools"}`;
const sum = (list: { tools: number }[]) =>
  list.reduce((total, item) => total + item.tools, 0);

/** Whether the policy includes a battery, or one fits a server. */
export function hasBatteries(batteries: Batteries): boolean {
  return (
    batteries.active.length +
      batteries.broken.length +
      batteries.available.length >
    0
  );
}

/**
 * The batteries the policy includes, the ones that do not hold, and the ones
 * that would cover more tools, with how far fixing and installing them would
 * take tool coverage, and a chat that does it.
 */
export function BatteriesCard({
  summary,
}: {
  summary: CoverageSummary | undefined;
}) {
  return (
    <Card className="gap-4 py-5">
      <CardHeader className="gap-1 px-5">
        <CardTitle>Batteries</CardTitle>
        <CardDescription className="text-xs">
          Ready-made rules for common MCP servers, enforced without writing them
          yourself
        </CardDescription>
      </CardHeader>
      {summary ? (
        <BatteriesContent summary={summary} />
      ) : (
        <CardContent className="space-y-4 px-5">
          <Skeleton className="h-20" />
          <Skeleton className="h-8" />
        </CardContent>
      )}
    </Card>
  );
}

function BatteriesContent({ summary }: { summary: CoverageSummary }) {
  const { batteries, totals } = summary;
  const { active, broken, available } = batteries;
  const unenforced = sum(broken);
  const added = sum(available);
  const actionable = broken.length + available.length > 0;
  // Every other battery in the catalog: not included, and fits no server.
  const catalog = useBatteries();
  const counted = new Set(
    [...active, ...broken, ...available].map((battery) => battery.name),
  );
  const others = catalog.data?.filter(
    (battery) => !counted.has(battery.name),
  ).length;

  return (
    <>
      <CardContent className="space-y-5 px-5">
        <div className="grid grid-cols-3 divide-x overflow-hidden rounded-md border">
          <StatTile
            label="Active"
            group="active"
            color={ACTIVE_COLOR}
            count={active.length}
            detail={`${tools(sum(active))} enforced`}
            empty="No included battery is enforced."
            rows={active.map((battery) => ({
              name: batteryDisplayName(battery.name),
              detail: tools(battery.tools),
            }))}
          />
          <StatTile
            label="Broken"
            group="broken"
            color={BROKEN_COLOR}
            count={broken.length}
            detail={`${tools(unenforced)} not enforced`}
            empty="Every included battery is enforced."
            rows={broken.map((battery) => ({
              name: batteryDisplayName(battery.name),
              detail: BATTERY_STATUS[battery.status].label.toLowerCase(),
            }))}
          />
          <StatTile
            label="Available"
            group="fits"
            count={available.length}
            detail={
              available.length === 0
                ? "none fit your servers"
                : `+${tools(added)}`
            }
            heading="Batteries that fit your servers"
            empty="No other battery fits your MCP servers."
            rows={available.map((battery) => ({
              name: batteryDisplayName(battery.name),
              detail: `+${tools(battery.tools)}`,
            }))}
            more={
              others
                ? {
                    label: `${others.toLocaleString()} more in catalog`,
                    group: "other",
                  }
                : undefined
            }
          />
        </div>
        {actionable ? (
          <ReachableCoverage
            total={totals.tools}
            custom={totals.root}
            battery={totals.battery}
            fixable={unenforced}
            installable={added}
          />
        ) : (
          <p className="text-muted-foreground text-sm">
            Every included battery is enforced, and no other battery fits your
            MCP servers.
          </p>
        )}
      </CardContent>
      {actionable && (
        <CardFooter className="mt-auto px-5">
          <Button size="sm" variant="outline" asChild>
            <Link href={openAppaChatHref({ promptKey: "configureBatteries" })}>
              <MessageCircle />
              <span>Configure with chat</span>
            </Link>
          </Button>
        </CardFooter>
      )}
    </>
  );
}

/**
 * One status: how many batteries, what they do to tools, and which ones on
 * hover. The whole tile opens the batteries page filtered to that status.
 */
function StatTile({
  label,
  group,
  color,
  count,
  detail,
  heading = `${label} batteries`,
  empty,
  rows,
  more,
}: {
  label: string;
  group: BatteryStatusGroup;
  /** Hollow when unset: a battery not included yet. */
  color?: string;
  count: number;
  detail: string;
  heading?: string;
  empty: string;
  rows: { name: string; detail: string }[];
  /** A second link in the tile, to a neighboring status. */
  more?: { label: string; group: BatteryStatusGroup };
}) {
  return (
    <div className="flex flex-col">
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            href={batteriesHref(group)}
            className="hover:bg-accent/50 focus-visible:ring-ring/50 flex flex-1 flex-col items-start gap-0.5 px-3 py-2.5 outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-inset"
          >
            <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <span
                aria-hidden
                className="border-muted-foreground size-2 shrink-0 rounded-full border"
                style={
                  color ? { backgroundColor: color, borderColor: color } : {}
                }
              />
              <span>{label}</span>
            </span>
            <span className="text-2xl font-semibold tabular-nums">
              {count.toLocaleString()}
            </span>
            <span className="text-muted-foreground text-xs tabular-nums">
              {detail}
            </span>
          </Link>
        </TooltipTrigger>
        <TooltipContent className="min-w-48 max-w-64">
          {rows.length === 0 ? (
            <span>{empty}</span>
          ) : (
            <div className="space-y-1">
              <p className="font-medium">{heading}</p>
              <ul className="space-y-0.5">
                {rows.slice(0, NAMED).map((row) => (
                  <li key={row.name} className="flex gap-3">
                    <span className="min-w-0 flex-1 truncate">{row.name}</span>
                    <span className="shrink-0 tabular-nums opacity-80">
                      {row.detail}
                    </span>
                  </li>
                ))}
              </ul>
              {rows.length > NAMED && (
                <p className="opacity-80">{`and ${rows.length - NAMED} more`}</p>
              )}
            </div>
          )}
        </TooltipContent>
      </Tooltip>
      {/* Its own full-width row, so it is as easy to hit as the tile above. */}
      {more && (
        <Link
          href={batteriesHref(more.group)}
          className="text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:ring-ring/50 flex min-h-9 items-center justify-between gap-2 border-t px-3 py-2 text-xs outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-inset"
        >
          <span className="tabular-nums">{more.label}</span>
          <ChevronRight aria-hidden className="size-3.5 shrink-0" />
        </Link>
      )}
    </div>
  );
}

/**
 * The share of tools a rule covers today, and how far fixing the broken
 * batteries and installing the available ones would take it.
 */
function ReachableCoverage({
  total,
  custom,
  battery,
  fixable,
  installable,
}: {
  total: number;
  custom: number;
  battery: number;
  fixable: number;
  installable: number;
}) {
  const today = custom + battery;
  const segments = [
    { key: "custom", label: "Custom rule", count: custom, fill: color("root") },
    {
      key: "battery",
      label: "Battery rule",
      count: battery,
      fill: ACTIVE_COLOR,
    },
    {
      key: "fixable",
      label: "Fixing broken batteries",
      count: fixable,
      fill: BROKEN_COLOR,
    },
    {
      key: "installable",
      label: "Installing available batteries",
      count: installable,
      fill: AVAILABLE_FILL,
    },
  ].filter((segment) => segment.count > 0);

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-muted-foreground">
          Tool coverage within reach
        </span>
        <span className="font-medium tabular-nums">
          {`${share(today, total)}% → ${share(today + fixable + installable, total)}%`}
        </span>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            role="img"
            aria-label={segments
              .map((segment) => `${segment.label}: ${segment.count}`)
              .join(", ")}
            className="bg-muted flex h-2 w-full gap-0.5 overflow-hidden rounded-full"
          >
            {segments.map((segment) => (
              <div
                key={segment.key}
                className="h-full"
                style={{
                  width: `${(segment.count / total) * 100}%`,
                  background: segment.fill,
                }}
              />
            ))}
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <dl className="space-y-1">
            {segments.map((segment) => (
              <div key={segment.key} className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: segment.fill }}
                />
                <dt>{segment.label}</dt>
                <dd className="ml-auto pl-3 tabular-nums">
                  {segment.key === "custom" || segment.key === "battery"
                    ? tools(segment.count)
                    : `+${tools(segment.count)}`}
                </dd>
              </div>
            ))}
          </dl>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
