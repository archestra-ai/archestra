"use client";

import Link from "next/link";
import { Fragment } from "react";
import { QueryLoadError } from "@/components/query-load-error";
import { Badge } from "@/components/ui/badge";
import {
  Card,
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
import {
  type AudienceLevel,
  useTrustAudience,
} from "@/lib/openappa-trust-audience.query";
import { policyLineHref, policyLineLabel } from "./policy-line-href";

/** The Overview's trust chain and audiences, with who belongs to each audience. */
export function TrustAudienceCard() {
  const view = useTrustAudience();

  return (
    <Card className="gap-5 py-5">
      <CardHeader className="px-5">
        <CardTitle>Trust & audience</CardTitle>
        <CardDescription>
          Trust is how much the agent can believe what it has read. Audience is
          who may see it: reading something private limits where the agent can
          send it.
        </CardDescription>
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
          <div className="grid items-center gap-8 md:grid-cols-[minmax(0,1fr)_15rem]">
            <div className="space-y-5">
              <div className="space-y-2">
                <h3 className="text-xs font-medium text-muted-foreground">
                  Trust
                </h3>
                <TrustChain levels={view.data.trust} />
              </div>
              <div className="space-y-1">
                <h3 className="text-xs font-medium text-muted-foreground">
                  Audience
                </h3>
                <ul className="divide-y divide-border/60">
                  {view.data.audiences.map((level) => (
                    <AudienceRow key={level.name} level={level} />
                  ))}
                </ul>
              </div>
            </div>
            <AudienceDiagram audiences={view.data.audiences} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// =============================================================================
// Internal components
// =============================================================================

/** Each level's color, shared by its legend dot and its ring. */
function toneOf(name: string): string {
  if (name === "public") return "var(--muted-foreground)";
  if (name === "internal") return "var(--chart-1)";
  if (name === "self") return "var(--chart-2)";
  return "var(--chart-3)";
}

/** Who the runtime counts in a level it has no sources for. */
const UNMAPPED_MEMBERS: Record<string, string> = {
  public: "Anyone",
  internal: "Only the session's user",
  self: "The session's user",
};

function TrustChain({ levels }: { levels: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {levels.map((name, index) => (
        <Fragment key={name}>
          {index > 0 && (
            <span aria-hidden="true" className="text-xs text-muted-foreground">
              →
            </span>
          )}
          <Badge variant="outline" className="font-mono font-normal">
            {name}
          </Badge>
        </Fragment>
      ))}
    </div>
  );
}

function AudienceRow({ level }: { level: AudienceLevel }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
      <span className="flex w-28 shrink-0 items-center gap-2">
        <span
          aria-hidden="true"
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: toneOf(level.name) }}
        />
        <span className="font-mono font-medium">{level.name}</span>
      </span>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {level.kind === "mapped" ? (
          <>
            {level.from.map((ref) => (
              <SourceChip key={`${ref.source}:${ref.selector}`} refTo={ref} />
            ))}
            {level.within && (
              <span className="text-xs text-muted-foreground">
                within {level.within}
              </span>
            )}
            <Link
              href={policyLineHref({ entry: null, line: level.mappingLine })}
              className="ml-auto font-mono text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              {policyLineLabel({ entry: null, line: level.mappingLine })}
            </Link>
          </>
        ) : (
          <span className="text-muted-foreground">
            {UNMAPPED_MEMBERS[level.name]}
          </span>
        )}
      </span>
    </li>
  );
}

type SelectorRef = Extract<AudienceLevel, { kind: "mapped" }>["from"][number];

function SourceChip({ refTo }: { refTo: SelectorRef }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={policyLineHref(refTo)}
          className="rounded-md border bg-muted/40 px-1.5 py-0.5 font-mono text-xs transition-colors hover:bg-muted"
        >
          {refTo.source}:{refTo.selector}
        </Link>
      </TooltipTrigger>
      <TooltipContent>
        {refTo.declaredBy ? (
          <span>
            From the {refTo.declaredBy.battery} battery,{" "}
            {policyLineLabel(refTo)}
          </span>
        ) : (
          <span>No included battery declares this source</span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The chain as circles that touch at the bottom, so each level visibly holds
 * the next: `public` ⊇ `internal` ⊇ `self`. Up to two groups within `internal`
 * sit beside `self`; each source is a bubble on its level's ring.
 */
function AudienceDiagram({ audiences }: { audiences: AudienceLevel[] }) {
  const byName = new Map(audiences.map((level) => [level.name, level]));
  const groups = audiences
    .filter(
      (level) =>
        level.kind === "mapped" &&
        level.name.startsWith("@") &&
        level.within === "internal",
    )
    .slice(0, GROUP_SLOTS.length);

  const ring = (circle: {
    name: string;
    cx: number;
    cy: number;
    r: number;
  }) => {
    const level = byName.get(circle.name);
    if (!level) return null;
    const tone = toneOf(circle.name);
    const isGroup = circle.name.startsWith("@");
    const sources = level.kind === "mapped" && !isGroup ? level.from : [];
    return (
      <g key={circle.name}>
        <circle
          cx={circle.cx}
          cy={circle.cy}
          r={circle.r}
          fill={tone}
          fillOpacity={0.07}
          stroke={tone}
          strokeOpacity={0.55}
          strokeWidth={1.25}
          strokeDasharray={
            level.kind === "mapped" || circle.name === "public"
              ? undefined
              : "3 3"
          }
        />
        {isGroup ? (
          <title>{circle.name}</title>
        ) : (
          <text
            x={circle.cx}
            y={circle.cy - circle.r + 16}
            textAnchor="middle"
            className="fill-foreground font-mono text-[10px]"
          >
            {circle.name}
          </text>
        )}
        {sources.map((ref, index) => {
          const angle = ((52 + index * 16) * Math.PI) / 180;
          return (
            <circle
              key={`${ref.source}:${ref.selector}`}
              cx={circle.cx + circle.r * Math.sin(angle)}
              cy={circle.cy - circle.r * Math.cos(angle)}
              r={4.5}
              fill={tone}
              stroke="var(--card)"
              strokeWidth={2}
            >
              <title>
                {ref.source}:{ref.selector}
              </title>
            </circle>
          );
        })}
      </g>
    );
  };

  return (
    <svg
      viewBox="0 0 240 200"
      role="img"
      aria-label="public contains internal, which contains self"
      className="mx-auto w-full max-w-60"
    >
      {ring({ name: "public", cx: 120, cy: 102, r: 96 })}
      {ring({ name: "internal", cx: 120, cy: 132, r: 66 })}
      {groups.map((group, index) =>
        ring({ name: group.name, ...GROUP_SLOTS[index], r: 14 }),
      )}
      {ring({ name: "self", cx: 120, cy: 162, r: 36 })}
    </svg>
  );
}

/** Where a group within `internal` fits: above `self`, inside `internal`'s ring. */
const GROUP_SLOTS = [
  { cx: 100, cy: 106 },
  { cx: 140, cy: 106 },
];
