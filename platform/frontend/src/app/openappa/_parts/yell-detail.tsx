"use client";

import { ShieldOff } from "lucide-react";
import {
  Fact,
  FactSub,
  FactsStrip,
  FactValue,
} from "@/components/log-detail/facts-strip";
import { PageBackLink } from "@/components/page-back-link";
import { QueryLoadError } from "@/components/query-load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useOpenAppaYell,
  useResolveOpenAppaYell,
} from "@/lib/openappa-yells.query";
import { formatDate, formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import {
  BROKE_THE_GLASS_HINT,
  YellCaller,
  YellRowActions,
  YellSignals,
} from "./yells-table";

/** One yell: its facts, its whole report, what it left behind. */
export function YellDetail({ id }: { id: string }) {
  const yell = useOpenAppaYell(id);
  const resolve = useResolveOpenAppaYell();
  const { data: canResolve } = useHasPermissions({ log: ["read"] });
  const back = (
    <PageBackLink href="/openappa/yells" labelled>
      <span>Back to yells</span>
    </PageBackLink>
  );

  if (yell.isPending)
    return (
      <div className="space-y-4" aria-busy="true">
        {back}
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>
    );
  if (yell.isError)
    return (
      <div className="space-y-4">
        {back}
        <QueryLoadError
          title="Couldn't load this yell"
          onRetry={() => yell.refetch()}
        />
      </div>
    );
  if (!yell.data)
    return (
      <div className="space-y-4">
        {back}
        <p className="text-sm text-muted-foreground">Yell not found.</p>
      </div>
    );

  const data = yell.data;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        {back}
        <YellRowActions
          yell={data}
          canResolve={!!canResolve}
          pending={resolve.isPending}
          onResolve={() =>
            resolve.mutate({ id: data.id, resolved: !data.resolvedAt })
          }
        />
      </div>
      <FactsStrip label="Yell facts">
        <Fact label="Reported">
          <FactValue>
            {formatDate({
              date: data.createdAt,
              dateFormat: "MMM d, HH:mm:ss",
            })}
          </FactValue>
          <FactSub>{formatRelativeTimeFromNow(data.createdAt)}</FactSub>
        </Fact>
        <Fact label="Reported by">
          <FactValue>
            <YellCaller yell={data} />
          </FactValue>
        </Fact>
        <Fact label="Status">
          <FactValue>{data.resolvedAt ? "Resolved" : "Unresolved"}</FactValue>
          {data.resolvedAt && (
            <FactSub>{formatRelativeTimeFromNow(data.resolvedAt)}</FactSub>
          )}
        </Fact>
        {data.superyell && (
          <Fact label="Guardrails">
            <FactValue>
              <span className="flex items-center gap-1.5">
                <ShieldOff className="size-3.5" aria-hidden="true" />
                Broke the glass
              </span>
            </FactValue>
            <FactSub>{BROKE_THE_GLASS_HINT.split(": ")[1]}</FactSub>
          </Fact>
        )}
        <Fact label="Signals">
          <FactValue>
            <YellSignals
              yell={data}
              empty={<span className="text-muted-foreground">None</span>}
            />
          </FactValue>
        </Fact>
      </FactsStrip>
      <section
        aria-label="Report"
        className="rounded-lg border border-border/70 bg-card p-4"
      >
        <h2 className="mb-2 text-sm font-medium">Report</h2>
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
          {data.message.trim()}
        </p>
      </section>
    </div>
  );
}
