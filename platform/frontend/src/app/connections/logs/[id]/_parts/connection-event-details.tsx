"use client";

import {
  KeyRound,
  type LucideIcon,
  Plug,
  RefreshCw,
  Sparkles,
  Unplug,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { AgentIcon, agentLabel } from "@/app/adoption/_parts/agent-icon";
import { AgentIdenticon, PersonAvatar } from "@/app/llm/logs/_parts/hue-avatar";
import { CopyButton } from "@/components/copy-button";
import {
  Fact,
  FactSub,
  FactsStrip,
  FactValue,
} from "@/components/log-detail/facts-strip";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { formatCompactRelativeTime, formatDate } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import type { ConnectionEventRecord } from "./use-connection-event";

/** What happened, as a label, a sentence fragment and a glyph. */
export function describeConnectionAction(event: ConnectionEventRecord): {
  label: string;
  /** Completes "<client> …" for the page title. */
  phrase: string;
  icon: LucideIcon;
} {
  switch (event.feedAction) {
    case "first_seen":
      return {
        label: "First seen",
        phrase: "seen for the first time",
        icon: Sparkles,
      };
    case "authorized":
      return { label: "Authorized", phrase: "authorized", icon: KeyRound };
    case "token_refreshed":
      return {
        label: "Token refreshed",
        phrase: "refreshed its token",
        icon: RefreshCw,
      };
    case "disconnected":
      return { label: "Disconnected", phrase: "disconnected", icon: Unplug };
    case "connected":
      return { label: "Connected", phrase: "connected", icon: Plug };
  }
  // Without the prototype field, the backend's own two actions.
  if (event.action === "disconnected") {
    return { label: "Disconnected", phrase: "disconnected", icon: Unplug };
  }
  return event.via === "oauthSignIn"
    ? { label: "Signed in", phrase: "signed in", icon: KeyRound }
    : { label: "Connected", phrase: "connected", icon: Plug };
}

export function connectionClient(event: ConnectionEventRecord) {
  return { clientId: event.clientId, name: event.agentName };
}

/** "Priya Raman" then the gateway it connected to, under the title. */
export function ConnectionIdentityLine({
  event,
}: {
  event: ConnectionEventRecord;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
      <span className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap">
        <PersonAvatar name={event.userName} size={16} ring={false} />
        <span className="truncate font-medium text-foreground">
          {event.userName}
        </span>
      </span>
      <span aria-hidden="true" className="text-muted-foreground/50">
        ·
      </span>
      <GatewayLabel event={event} />
    </div>
  );
}

/**
 * The action, the client and its version, who and where it connected to, the
 * machine, and when. The second row holds the identifiers.
 */
export function ConnectionEventFacts({
  event,
}: {
  event: ConnectionEventRecord;
}) {
  const action = describeConnectionAction(event);
  const ActionIcon = action.icon;
  const client = connectionClient(event);
  const at = event.occurredAt;

  return (
    <FactsStrip
      label="Connection event facts"
      footerLabel="Identifiers"
      footer={<IdentifiersRow event={event} />}
    >
      <Fact label="Action">
        <FactValue>
          <ActionIcon
            className={cn(
              "size-4 shrink-0",
              event.action === "disconnected"
                ? "text-amber-600 dark:text-amber-400"
                : "text-muted-foreground",
            )}
            aria-hidden="true"
          />
          <span>{action.label}</span>
        </FactValue>
        <FactSub>
          {event.action === "disconnected"
            ? `by ${event.disconnectedBy?.name ?? event.userName}`
            : event.via === "oauthSignIn"
              ? "via OAuth sign-in"
              : "via Connect page setup"}
        </FactSub>
      </Fact>

      <Fact label="Client">
        <FactValue>
          <AgentIcon agent={client} size={18} />
          <span className="truncate text-sm font-medium">
            {agentLabel(client)}
          </span>
        </FactValue>
        <FactSub>
          {event.clientVersion ? (
            <span className="font-mono">v{event.clientVersion}</span>
          ) : (
            <span>Version not reported</span>
          )}
        </FactSub>
      </Fact>

      <Fact label="User">
        <FactValue>
          <PersonAvatar name={event.userName} size={18} ring={false} />
          <span className="truncate text-sm font-medium">{event.userName}</span>
        </FactValue>
        {event.userEmail ? <FactSub>{event.userEmail}</FactSub> : null}
      </Fact>

      <Fact label="MCP gateway">
        <FactValue muted={!event.mcpGateway}>
          <span className="truncate text-sm font-medium">
            {event.mcpGateway?.name ?? "Not known yet"}
          </span>
        </FactValue>
        <FactSub>
          {event.llmProxy
            ? `LLM proxy: ${event.llmProxy.name}`
            : "No LLM proxy"}
        </FactSub>
      </Fact>

      <Fact label="Device">
        <FactValue muted={!event.deviceName}>
          <span className="truncate font-mono text-sm font-medium">
            {event.deviceName ?? "Not reported"}
          </span>
        </FactValue>
        {event.platform ? (
          <FactSub>{PLATFORM_LABEL[event.platform]}</FactSub>
        ) : null}
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
    </FactsStrip>
  );
}

/**
 * The same member's other events from the same client, newest first, so a
 * reader sees where this one falls: set up, refreshed, disconnected.
 */
export function ConnectionRecentActivity({
  event,
  recent,
  pending,
}: {
  event: ConnectionEventRecord;
  recent: ConnectionEventRecord[];
  pending: boolean;
}) {
  const client = connectionClient(event);
  const others = recent.filter((e) => e.id !== event.id).length;
  return (
    <section
      aria-label="Recent activity"
      className="overflow-hidden rounded-lg border bg-card shadow-[0_1px_2px_0_rgb(0_0_0/0.03)]"
    >
      <header className="flex min-w-0 items-center gap-2 border-b px-4 py-2.5">
        <h2 className="shrink-0 text-sm font-medium">Recent activity</h2>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {event.userName} · {agentLabel(client)}
        </span>
        {!pending ? (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
            {others} other {others === 1 ? "event" : "events"}
          </span>
        ) : null}
      </header>
      {pending ? (
        <div className="space-y-2 p-4" aria-busy="true">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : (
        <ol className="divide-y">
          {recent.map((e) => (
            <RecentRow key={e.id} event={e} current={e.id === event.id} />
          ))}
          {others === 0 ? (
            <li className="px-4 py-3 text-sm text-muted-foreground">
              No other events from this member and client.
            </li>
          ) : null}
        </ol>
      )}
    </section>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

const PLATFORM_LABEL: Record<
  NonNullable<ConnectionEventRecord["platform"]>,
  string
> = {
  macos: "macOS",
  linux: "Linux",
  windows: "Windows",
};

function RecentRow({
  event,
  current,
}: {
  event: ConnectionEventRecord;
  current: boolean;
}) {
  const action = describeConnectionAction(event);
  const Icon = action.icon;
  const body = (
    <>
      <Icon
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{action.label}</span>
          {current ? (
            <span className="shrink-0 rounded-full bg-primary/10 px-1.5 text-[11px] leading-4 font-medium text-primary">
              This event
            </span>
          ) : null}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {[
            event.mcpGateway?.name,
            event.clientVersion ? `v${event.clientVersion}` : null,
            event.deviceName,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
      <time
        dateTime={event.occurredAt}
        title={formatDate({ date: event.occurredAt })}
        className="shrink-0 text-right text-xs leading-4 text-muted-foreground tabular-nums"
      >
        <span className="block text-foreground/80">
          {formatCompactRelativeTime(event.occurredAt)}
        </span>
        <span className="block">
          {formatDate({ date: event.occurredAt, dateFormat: "MMM d · HH:mm" })}
        </span>
      </time>
    </>
  );
  const rowClass = "flex items-center gap-3 px-4 py-2.5";
  return (
    <li>
      {current ? (
        <div className={cn(rowClass, "bg-primary/[0.04]")} aria-current="page">
          {body}
        </div>
      ) : (
        <Link
          href={`/connections/logs/${event.id}`}
          className={cn(rowClass, "transition-colors hover:bg-muted/40")}
        >
          {body}
        </Link>
      )}
    </li>
  );
}

function GatewayLabel({ event }: { event: ConnectionEventRecord }) {
  const gateway = event.mcpGateway;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap">
      <AgentIdenticon
        seed={gateway?.id ?? "unknown"}
        name={gateway?.name ?? "MCP Gateway"}
        variant={gateway ? "agent" : "deleted"}
        size="sm"
      />
      <span className="sr-only">MCP Gateway:</span>
      <span className="truncate">
        {gateway?.name ?? "Gateway not known yet"}
      </span>
    </span>
  );
}

function IdentifiersRow({ event }: { event: ConnectionEventRecord }) {
  const pairs = [
    { label: "Event", value: event.id },
    { label: "Client", value: event.clientId },
    { label: "User", value: event.userId },
  ].filter((p): p is { label: string; value: string } => !!p.value);
  const added = [
    event.mcpGateway ? "MCP gateway" : null,
    event.llmProxy ? "LLM proxy" : null,
    event.includeSkills
      ? event.skillCount > 0
        ? `${event.skillCount} skills`
        : "Skills"
      : null,
  ].filter((x): x is string => x !== null);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
      {pairs.map(({ label, value }) => (
        <LabelledValue key={label} label={label}>
          <span className="truncate font-mono" title={value}>
            {value}
          </span>
          <CopyButton text={value} size={12} />
        </LabelledValue>
      ))}
      {event.action === "connected" && added.length > 0 ? (
        <LabelledValue label="Added">
          <span>{added.join(", ")}</span>
        </LabelledValue>
      ) : null}
    </div>
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
