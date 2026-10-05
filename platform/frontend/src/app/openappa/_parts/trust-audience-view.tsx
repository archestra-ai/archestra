"use client";

import { AlertTriangle, ChevronRight, Info } from "lucide-react";
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { OUTCOME_LABEL } from "@/app/consults/logs/_components/consult-outcome-badge";
import { QueryLoadError } from "@/components/query-load-error";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
  type AudienceSource,
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

/** The Trust & audience tab: trust levels, audiences, and audience sources. */
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
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );

  const { trust, audiences, sources } = view.data;
  return (
    <div className="space-y-8">
      <Section
        id="trust-audience-trust"
        title="Trust"
        hint="How much the agent can believe what it has read."
      >
        <LevelChain levels={trust.map((name) => ({ name }))} />
      </Section>
      <Section
        id="trust-audience-audience"
        title="Audience"
        hint="Who is allowed to see what the agent has read. Reading something private limits where the agent can send it."
      >
        <div className="divide-y rounded-lg border">
          {audiences.map((level) => (
            <AudienceRow key={level.name} level={level} />
          ))}
        </div>
      </Section>
      <Section
        id="trust-audience-sources"
        title="Audience sources"
        hint="Where the people in each audience are looked up."
      >
        {sources.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No included battery declares an audience source.
          </p>
        ) : (
          <div className="divide-y rounded-lg border">
            {sources.map((source) => (
              <SourceRow
                key={`${source.entry}:${source.name}`}
                source={source}
                canSeeConsults={canSeeConsults === true}
              />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

// =============================================================================
// Internal components
// =============================================================================

const WARNING_CLASSES =
  "border-amber-500/50 text-amber-800 dark:border-amber-500/40 dark:text-amber-300";

const ROW = "grid items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm";
const AUDIENCE_COLUMNS =
  "grid-cols-[1rem_minmax(0,1fr)] sm:grid-cols-[1rem_8rem_minmax(0,1fr)_auto]";

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
      <div className="flex items-center gap-1.5">
        <h2 id={id} className="text-base font-semibold">
          {title}
        </h2>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`About ${title.toLowerCase()}`}
              className="text-muted-foreground"
            >
              <Info className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">{hint}</TooltipContent>
        </Tooltip>
      </div>
      {children}
    </section>
  );
}

function AudienceRow({ level }: { level: AudienceLevel }) {
  const cells = (
    <>
      <span className="font-mono">{level.name}</span>
      <span className="col-start-2 sm:col-start-auto">
        <AudienceFrom level={level} />
      </span>
      <span className="col-start-2 sm:col-start-auto sm:text-right">
        <RuleCount level={level} />
      </span>
    </>
  );
  if (level.kind !== "mapped")
    return (
      <div className={cn(ROW, AUDIENCE_COLUMNS)}>
        <span />
        {cells}
      </div>
    );
  return (
    <Collapsible>
      <div className={cn(ROW, AUDIENCE_COLUMNS)}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            aria-label={`Show where ${level.name} is mapped`}
            className="group text-muted-foreground"
          >
            <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
          </button>
        </CollapsibleTrigger>
        {cells}
      </div>
      <CollapsibleContent>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 pb-3 pl-11 pr-4 text-sm">
          <dt className="text-muted-foreground">Mapped</dt>
          <dd>
            <LineLink at={{ entry: null, line: level.mappingLine }} />
          </dd>
          {level.from.map((ref) => (
            <Fragment key={`${ref.source}:${ref.selector}`}>
              <dt className="text-muted-foreground">{ref.source}</dt>
              <dd>
                {ref.line === null ? (
                  <span className="text-muted-foreground">
                    No included battery declares this source
                  </span>
                ) : (
                  <LineLink at={ref} />
                )}
              </dd>
            </Fragment>
          ))}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}

function AudienceFrom({ level }: { level: AudienceLevel }) {
  switch (level.kind) {
    case "builtin":
      return <span className="text-muted-foreground">built in</span>;
    case "unmapped":
      return (
        <span className="inline-flex items-center gap-1 text-amber-800 dark:text-amber-300">
          <AlertTriangle className="size-3.5" aria-hidden="true" />
          <span>not mapped</span>
        </span>
      );
    case "mapped":
      if (level.from.length === 0)
        return <span className="text-muted-foreground">no sources</span>;
      return (
        <span>
          {level.from.map((ref, index) => (
            <Fragment key={`${ref.source}:${ref.selector}`}>
              {index > 0 && <span className="text-muted-foreground"> or </span>}
              <span className="font-mono">
                {ref.source}:{ref.selector}
              </span>
            </Fragment>
          ))}
        </span>
      );
  }
}

function RuleCount({ level }: { level: AudienceLevel }) {
  const label = `${level.ruleCount} ${level.ruleCount === 1 ? "rule" : "rules"}`;
  if (!level.firstRule)
    return <span className="text-muted-foreground">{label}</span>;
  return (
    <Link
      href={policyLineHref(level.firstRule)}
      className="underline-offset-4 hover:underline"
    >
      {label}
    </Link>
  );
}

function SourceRow({
  source,
  canSeeConsults,
}: {
  source: AudienceSource;
  canSeeConsults: boolean;
}) {
  const appName = useAppName();
  return (
    <div
      className={cn(
        ROW,
        "grid-cols-[1rem_minmax(0,1fr)] sm:grid-cols-[1rem_8rem_minmax(0,1fr)_auto]",
      )}
    >
      <span>
        {canSeeConsults && <ConsultDot consult={source.lastConsult} />}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="w-fit font-mono">{source.name}</span>
        </TooltipTrigger>
        <TooltipContent>
          {source.runBy === "archestra"
            ? `${appName} answers this source`
            : "The battery's helper answers this source"}
        </TooltipContent>
      </Tooltip>
      <span className="col-start-2 flex flex-wrap gap-1 sm:col-start-auto">
        {source.templates.map(({ template }) => (
          <Badge
            key={template}
            variant="outline"
            className="rounded-md font-mono font-normal"
          >
            {template}
          </Badge>
        ))}
      </span>
      <span className="col-start-2 flex flex-wrap items-center gap-x-4 gap-y-1 sm:col-start-auto sm:justify-end">
        <span
          className={cn(source.usedBy.length === 0 && "text-muted-foreground")}
        >
          {source.usedBy.length > 0 ? source.usedBy.join(", ") : "unused"}
        </span>
        <LineLink at={source} />
        <Link
          href={`/consults/logs?${new URLSearchParams({ externalName: source.name })}`}
          className="underline-offset-4 hover:underline"
        >
          Logs
        </Link>
      </span>
    </div>
  );
}

function ConsultDot({ consult }: { consult: AudienceSource["lastConsult"] }) {
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
