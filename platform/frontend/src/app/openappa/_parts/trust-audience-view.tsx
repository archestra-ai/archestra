"use client";

import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { OUTCOME_LABEL } from "@/app/consults/logs/_components/consult-outcome-badge";
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
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  type AudienceLevel,
  useTrustAudience,
} from "@/lib/openappa-trust-audience.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import { policyLineHref, policyLineLabel } from "./policy-line-href";

/** Levels as chips joined by arrows; a `warn` level is styled as a warning. */
export function LevelChain({
  levels,
}: {
  levels: { name: string; warn?: boolean }[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {levels.map((level, index) => (
        <Fragment key={level.name}>
          {index > 0 && (
            <span aria-hidden="true" className="text-xs text-muted-foreground">
              →
            </span>
          )}
          <Badge
            variant="outline"
            className={cn("font-mono", level.warn && WARNING_CLASSES)}
          >
            {level.name}
          </Badge>
        </Fragment>
      ))}
    </div>
  );
}

/** The Trust & audience tab: the trust chain, then one card per audience. */
export function TrustAudienceView() {
  const view = useTrustAudience();
  const { data: canSeeConsults } = useHasPermissions({
    openappaDiagnostics: ["admin"],
  });

  if (view.isLoadingError)
    return (
      <QueryLoadError
        title="Could not load trust and audience"
        onRetry={() => view.refetch()}
      />
    );
  if (!view.data)
    return (
      <div className="space-y-6">
        <Skeleton className="h-20 w-full max-w-md" />
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
        </div>
      </div>
    );

  const { trust, audiences } = view.data;
  return (
    <div className="space-y-8">
      <Section
        id="trust-audience-trust"
        title="Trust"
        hint="How much the agent can believe what it has read."
      >
        <Card className="w-fit py-4">
          <CardContent className="px-4">
            <LevelChain levels={trust.map((name) => ({ name }))} />
          </CardContent>
        </Card>
      </Section>
      <Section
        id="trust-audience-audience"
        title="Audience"
        hint="Who is allowed to see what the agent has read. Reading something private limits where the agent can send it."
      >
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {audiences.map((level) => (
            <AudienceCard
              key={level.name}
              level={level}
              canSeeConsults={canSeeConsults === true}
            />
          ))}
        </div>
      </Section>
    </div>
  );
}

// =============================================================================
// Internal components
// =============================================================================

const WARNING_CLASSES =
  "border-amber-500/50 text-amber-800 dark:border-amber-500/40 dark:text-amber-300";

type SelectorRef = Extract<AudienceLevel, { kind: "mapped" }>["from"][number];

function Section({
  id,
  title,
  hint,
  children,
}: {
  id: string;
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div className="space-y-0.5">
        <h2 id={id} className="text-base font-semibold">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
      {children}
    </section>
  );
}

function AudienceCard({
  level,
  canSeeConsults,
}: {
  level: AudienceLevel;
  canSeeConsults: boolean;
}) {
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="font-mono text-sm">{level.name}</CardTitle>
          <KindBadge level={level} />
        </div>
        {level.kind === "mapped" && (
          <CardDescription className="text-xs">
            {level.within && <>Within {level.within} · </>}
            Mapped at <LineLink at={{ entry: null, line: level.mappingLine }} />
          </CardDescription>
        )}
      </CardHeader>
      {level.kind === "unmapped" && (
        <CardContent className="px-4 text-sm text-muted-foreground">
          Rules use it, but <span className="font-mono">[policy.audience]</span>{" "}
          does not map it.
        </CardContent>
      )}
      {level.kind === "mapped" && (
        <CardContent className="space-y-2 px-4 text-sm">
          {level.from.length === 0 ? (
            <span className="text-muted-foreground">No sources</span>
          ) : (
            level.from.map((ref, index) => (
              <Fragment key={`${ref.source}:${ref.selector}`}>
                {index > 0 && (
                  <div className="text-xs text-muted-foreground">or</div>
                )}
                <SourceBlock refTo={ref} canSeeConsults={canSeeConsults} />
              </Fragment>
            ))
          )}
        </CardContent>
      )}
    </Card>
  );
}

function KindBadge({ level }: { level: AudienceLevel }) {
  switch (level.kind) {
    case "builtin":
      return <Badge variant="outline">Built in</Badge>;
    case "mapped":
      return null;
    case "unmapped":
      return (
        <Badge variant="outline" className={cn("gap-1", WARNING_CLASSES)}>
          <AlertTriangle className="size-3" aria-hidden="true" />
          Not mapped
        </Badge>
      );
  }
}

function SourceBlock({
  refTo,
  canSeeConsults,
}: {
  refTo: SelectorRef;
  canSeeConsults: boolean;
}) {
  const appName = useAppName();
  const declared = refTo.declaredBy;
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2">
        {declared && canSeeConsults && (
          <ConsultDot consult={declared.lastConsult} />
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="w-fit break-all font-mono">
              {refTo.source}:{refTo.selector}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {!declared
              ? "No included battery declares this source"
              : declared.runBy === "archestra"
                ? `${appName} answers this source`
                : `The ${declared.battery} battery's helper answers this source`}
          </TooltipContent>
        </Tooltip>
      </div>
      {declared ? (
        <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          <LineLink at={refTo} />
          <Link
            href={`/consults/logs?${new URLSearchParams({ externalName: refTo.source })}`}
            className="underline-offset-4 hover:underline"
          >
            Logs
          </Link>
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">
          No included battery declares this source
        </div>
      )}
    </div>
  );
}

function ConsultDot({
  consult,
}: {
  consult: NonNullable<SelectorRef["declaredBy"]>["lastConsult"];
}) {
  const label = consult
    ? `Last consult: ${OUTCOME_LABEL[consult.outcome]}, ${formatRelativeTimeFromNow(consult.at)}`
    : "Not consulted yet";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={label}
          className={cn(
            "inline-block size-2 rounded-full",
            !consult
              ? "border border-muted-foreground"
              : consult.outcome === "answered"
                ? "bg-emerald-500"
                : "bg-destructive",
          )}
        />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function LineLink({
  at,
}: {
  at: { entry: string | null; line: number | null };
}) {
  return (
    <Link
      href={policyLineHref(at)}
      className="font-mono text-xs underline-offset-4 hover:underline"
    >
      {policyLineLabel(at)}
    </Link>
  );
}
