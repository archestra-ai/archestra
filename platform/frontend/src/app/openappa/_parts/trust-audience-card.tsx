"use client";

import Link from "next/link";
import { Fragment, type ReactNode } from "react";
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
  type AudienceLevel,
  useTrustAudience,
} from "@/lib/openappa-trust-audience.query";
import { cn } from "@/lib/utils/tailwind";
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
          who is allowed to see it: reading something private limits where the
          agent can send it.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-5">
        {view.isLoadingError ? (
          <QueryLoadError
            title="Could not load trust and audience"
            onRetry={() => view.refetch()}
          />
        ) : !view.data ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-4 gap-y-4 text-sm">
            <dt className="text-muted-foreground">Trust</dt>
            <dd className="flex flex-wrap items-center gap-1.5">
              {view.data.trust.map((name, index) => (
                <Fragment key={name}>
                  {index > 0 && (
                    <span
                      aria-hidden="true"
                      className="text-xs text-muted-foreground"
                    >
                      →
                    </span>
                  )}
                  <Badge variant="outline" className="font-mono">
                    {name}
                  </Badge>
                </Fragment>
              ))}
            </dd>
            <dt className="text-muted-foreground">Audience</dt>
            <dd>
              <AudienceDiagram audiences={view.data.audiences} />
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

/**
 * The audience chain as nested rings, `public` ⊇ `internal` ⊇ `self`, each group
 * drawn inside the level it is declared `within`, and each source bubble on the
 * ring it supplies members to.
 */
function AudienceDiagram({ audiences }: { audiences: AudienceLevel[] }) {
  const level = (name: string) => audiences.find((each) => each.name === name);
  const groupsWithin = (name: string | null) =>
    audiences
      .filter(
        (each) =>
          each.kind === "mapped" &&
          each.name.startsWith("@") &&
          (each.within ?? "public") === name,
      )
      .map((group) => (
        <Ring
          key={group.name}
          level={group}
          tone={TONES.group}
          size="min-w-36"
        />
      ));
  const publicLevel = level("public");
  const internal = level("internal");
  const self = level("self");
  if (!publicLevel || !internal || !self) return null;

  return (
    <Ring
      level={publicLevel}
      tone={TONES.public}
      size="mx-auto w-full max-w-2xl"
    >
      <Ring level={internal} tone={TONES.internal} size="w-[80%]">
        <Ring level={self} tone={TONES.self} size="w-[55%] min-w-44">
          {groupsWithin("self")}
        </Ring>
        {groupsWithin("internal")}
      </Ring>
      {groupsWithin("public")}
    </Ring>
  );
}

const TONES = {
  public: "border-border bg-muted/30",
  internal: "border-sky-500/40 bg-sky-500/5",
  self: "border-violet-500/40 bg-violet-500/10",
  group: "border-emerald-500/40 bg-emerald-500/10",
};

function Ring({
  level,
  tone,
  size,
  children,
}: {
  level: AudienceLevel;
  tone: string;
  size: string;
  children?: ReactNode;
}) {
  const hasChildren = Array.isArray(children)
    ? children.some((child) => (Array.isArray(child) ? child.length : child))
    : Boolean(children);
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 rounded-[50%] border px-[8%] pt-7 pb-9 text-center",
        size,
        tone,
        level.kind !== "mapped" && level.name !== "public" && "border-dashed",
      )}
    >
      <div className="flex flex-col items-center gap-1.5">
        <span className="font-mono text-sm font-medium">{level.name}</span>
        <Members level={level} />
      </div>
      {hasChildren && (
        <div className="flex w-full flex-wrap items-center justify-center gap-4">
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * Who the runtime counts in a level: the bubbles of the sources it reads, or,
 * unmapped, the session's user, which a user's session carries as `self`.
 */
function Members({ level }: { level: AudienceLevel }) {
  if (level.kind !== "mapped")
    return (
      <span className="text-xs text-muted-foreground">
        {UNMAPPED_MEMBERS[level.name]}
      </span>
    );
  return (
    <span className="flex flex-wrap items-center justify-center gap-1.5">
      {level.from.map((ref) => (
        <Link
          key={`${ref.source}:${ref.selector}`}
          href={policyLineHref(ref)}
          title={
            ref.declaredBy
              ? `From the ${ref.declaredBy.battery} battery, ${policyLineLabel(ref)}`
              : "No included battery declares this source"
          }
          className="rounded-full border bg-background px-2.5 py-0.5 font-mono text-xs shadow-xs hover:bg-accent"
        >
          {ref.source}:{ref.selector}
        </Link>
      ))}
      <Link
        href={policyLineHref({ entry: null, line: level.mappingLine })}
        className="font-mono text-[11px] text-muted-foreground underline-offset-4 hover:underline"
      >
        {policyLineLabel({ entry: null, line: level.mappingLine })}
      </Link>
    </span>
  );
}

const UNMAPPED_MEMBERS: Record<string, string> = {
  public: "anyone",
  internal: "only the session's user",
  self: "the session's user",
};
