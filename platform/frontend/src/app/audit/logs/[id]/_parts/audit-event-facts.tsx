"use client";

import { ShieldBan, VenetianMask, X } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { UAParser } from "ua-parser-js";
import { describeAuditActor } from "@/app/audit/logs/_parts/audit-actor-cell";
import { auditResourceIcon } from "@/app/audit/logs/_parts/audit-event-taxonomy";
import {
  formatResourceType,
  OUTCOME_LABEL,
  resourceDisplayName,
} from "@/app/audit/logs/_parts/audit-log-action-labels";
import { PersonAvatar } from "@/app/llm/logs/_parts/hue-avatar";
import { CopyButton } from "@/components/copy-button";
import {
  Fact,
  FactSub,
  FactsStrip,
  FactValue,
} from "@/components/log-detail/facts-strip";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import type { AuditLog } from "@/lib/audit-log/audit-log.query";
import { formatCompactRelativeTime, formatDate } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";

/** The resource type's glyph for the header tile; red when it did not go through. */
export function AuditEventHeaderIcon({ event }: { event: AuditLog }) {
  const Icon = auditResourceIcon(event.resourceType);
  return (
    <Icon
      className={cn(
        "size-6",
        event.outcome === "success" ? "text-foreground/70" : "text-destructive",
      )}
      aria-hidden="true"
    />
  );
}

/**
 * "Priya Raman" then "Support bot · Agent", under the title. Who acted and
 * what they acted on are the two halves of an audit record's identity.
 */
export function AuditEventIdentityLine({ event }: { event: AuditLog }) {
  const actor = describeAuditActor(event);
  const name = resourceDisplayName(event);
  const typeLabel = event.resourceType
    ? formatResourceType(event.resourceType)
    : null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
      <span className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap">
        <span
          className={cn(
            "truncate font-medium text-foreground",
            actor.quiet && "font-normal text-muted-foreground",
          )}
        >
          {actor.name}
        </span>
        {event.impersonatedBy ? (
          <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
            <VenetianMask className="size-3.5" aria-hidden="true" />
            <span>
              as impersonated by {event.impersonatedByEmail ?? "a deleted user"}
            </span>
          </span>
        ) : null}
      </span>
      {name || typeLabel ? (
        <>
          <span aria-hidden="true" className="text-muted-foreground/50">
            ·
          </span>
          <span className="inline-flex min-w-0 items-center gap-1 whitespace-nowrap">
            {name ? (
              <span className="truncate text-foreground/80">{name}</span>
            ) : null}
            {typeLabel ? (
              <span className="shrink-0">
                {name ? <span>· </span> : null}
                {typeLabel}
              </span>
            ) : null}
          </span>
        </>
      ) : null}
    </div>
  );
}

/**
 * Outcome, time, the request that carried the change, who made it and from
 * where. Its second row holds the identifiers an investigator copies into a
 * ticket or a log search.
 */
export function AuditEventFacts({ event }: { event: AuditLog }) {
  const at = event.occurredAt ?? event.createdAt;
  const failed = event.outcome !== "success";
  const OutcomeIcon = event.outcome === "denied" ? ShieldBan : X;
  const actor = describeAuditActor(event);
  const client = useMemo(
    () => describeUserAgent(event.userAgent),
    [event.userAgent],
  );
  // MCP-tool rows carry a surface marker (`mcp-tool:<name>`) in httpPath with
  // no method.
  const mcpTool =
    !event.httpMethod && event.httpPath?.startsWith("mcp-tool:")
      ? event.httpPath.slice("mcp-tool:".length)
      : null;

  return (
    <FactsStrip
      label="Audit event facts"
      footerLabel="Identifiers"
      footer={<IdentifiersRow event={event} />}
    >
      <Fact label="Outcome">
        <FactValue>
          <span
            className={cn(
              "inline-flex items-center gap-1.5",
              failed && "text-destructive",
            )}
          >
            {failed ? (
              <OutcomeIcon className="size-4" aria-hidden="true" />
            ) : (
              <span
                aria-hidden="true"
                className="size-2 rounded-full bg-emerald-500"
              />
            )}
            <span>{OUTCOME_LABEL[event.outcome]}</span>
          </span>
        </FactValue>
        <FactSub>
          {event.httpStatus != null
            ? `HTTP ${event.httpStatus}`
            : "No HTTP status"}
        </FactSub>
      </Fact>

      <Fact label="Time">
        <Tooltip>
          <TooltipTrigger asChild>
            <UnstyledButton className="block w-full min-w-0 cursor-default text-left">
              <FactValue>
                {formatDate({ date: at, dateFormat: "MMM d, HH:mm:ss" })}
              </FactValue>
              <FactSub>{formatCompactRelativeTime(at)}</FactSub>
            </UnstyledButton>
          </TooltipTrigger>
          <TooltipContent className="px-2 py-1.5 font-mono tabular-nums">
            {formatDate({ date: at })}
          </TooltipContent>
        </Tooltip>
      </Fact>

      <Fact label="Request" className="lg:flex-[2_1_240px]">
        {mcpTool ? (
          <>
            <FactValue>
              <span className="truncate font-mono text-sm">{mcpTool}</span>
            </FactValue>
            <FactSub>MCP tool</FactSub>
          </>
        ) : event.httpMethod || event.httpRoute || event.httpPath ? (
          <>
            <FactValue>
              <span className="flex min-w-0 items-baseline gap-1.5 font-mono text-sm">
                {event.httpMethod ? (
                  <span className="shrink-0 font-semibold">
                    {event.httpMethod}
                  </span>
                ) : null}
                <span
                  className="truncate font-medium"
                  title={event.httpRoute ?? event.httpPath ?? undefined}
                >
                  {event.httpRoute ?? event.httpPath}
                </span>
              </span>
            </FactValue>
            {event.httpPath && event.httpPath !== event.httpRoute ? (
              <FactSub>
                <span className="font-mono" title={event.httpPath}>
                  {event.httpPath}
                </span>
              </FactSub>
            ) : null}
          </>
        ) : (
          <>
            <FactValue muted>Background</FactValue>
            <FactSub>No HTTP request</FactSub>
          </>
        )}
      </Fact>

      <Fact label="Actor">
        <FactValue>
          {actor.kind === "person" ? (
            <PersonAvatar name={actor.name} size={18} ring={false} />
          ) : (
            <actor.icon
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          )}
          <span className="truncate text-sm font-medium" title={actor.name}>
            {actor.name}
          </span>
        </FactValue>
        <FactSub>{actor.secondary}</FactSub>
      </Fact>

      <Fact label="Source IP">
        <FactValue muted={!event.sourceIp}>
          <span className="font-mono text-sm font-medium">
            {event.sourceIp ?? "Not recorded"}
          </span>
        </FactValue>
        {client ? <FactSub>{client}</FactSub> : null}
      </Fact>
    </FactsStrip>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

function IdentifiersRow({ event }: { event: AuditLog }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
      <IdPair label="Event" value={event.id} />
      {event.requestId ? (
        <IdPair label="Request" value={event.requestId} />
      ) : null}
      {event.resourceId ? (
        <IdPair label="Resource" value={event.resourceId} />
      ) : null}
      {event.actorId ? <IdPair label="Actor" value={event.actorId} /> : null}
      {event.userAgent ? (
        <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
          <span className="shrink-0 text-muted-foreground">User agent</span>
          <span
            className="min-w-0 truncate font-mono text-foreground"
            title={event.userAgent}
          >
            {event.userAgent}
          </span>
        </span>
      ) : null}
    </div>
  );
}

function IdPair({ label, value }: { label: string; value: string }) {
  return (
    <LabelledValue label={label}>
      <span className="truncate font-mono" title={value}>
        {value}
      </span>
      <CopyButton text={value} size={12} />
    </LabelledValue>
  );
}

function LabelledValue({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="inline-flex min-w-0 items-center gap-0.5 text-foreground">
        {children}
      </span>
    </span>
  );
}

function describeUserAgent(userAgent: string | null | undefined) {
  if (!userAgent) return null;
  const parsed = UAParser(userAgent);
  const browser = [parsed.browser.name, parsed.browser.major]
    .filter(Boolean)
    .join(" ");
  const label = [browser, parsed.os.name].filter(Boolean).join(" on ");
  return label || null;
}
