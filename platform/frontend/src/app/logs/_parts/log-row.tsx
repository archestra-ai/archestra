"use client";

import {
  Bot,
  ChevronRight,
  Clock,
  Laptop,
  type LucideIcon,
  Plug,
  ScrollText,
  Shield,
  Sparkles,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { AgentIdenticon, PersonAvatar } from "@/app/llm/logs/_parts/hue-avatar";
import { MakerDisc } from "@/app/llm/logs/_parts/maker-disc";
import { Skeleton } from "@/components/ui/skeleton";
import {
  formatCost,
  formatDuration,
  formatTokens,
  type LogEvent,
  type LogSource,
  type LogStatus,
  SOURCE_BY_ID,
  STATUS_LABEL,
} from "@/lib/logs/log-events.query";
import { cn } from "@/lib/utils/tailwind";

/**
 * One event, one line on desktop (two on a phone). The whole row is a link to
 * the event's own detail page, so cmd/ctrl-click opens it in a new tab.
 */
export function LogRow({
  event,
  showSource,
}: {
  event: LogEvent;
  /** False once a type is picked: every row would say the same thing. */
  showSource: boolean;
}) {
  const source = SOURCE_BY_ID[event.source];
  const tone = PROBLEM_TONE[event.status];
  return (
    <Link
      href={event.href}
      title={new Date(event.timestamp).toLocaleString()}
      className={cn(
        "group relative grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5 py-2 pr-3 pl-3.5 text-sm outline-none transition-colors",
        "hover:bg-muted/50 focus-visible:bg-muted/60",
        "@3xl:flex @3xl:h-[34px] @3xl:gap-3 @3xl:py-0",
        tone?.row,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 w-[3px]",
          tone ? tone.accent : source.dot,
        )}
      />

      {/* Lead: time (desktop) and the agent badge or source tile. */}
      <time
        dateTime={event.timestamp}
        className="hidden w-[3.75rem] shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums @3xl:block"
      >
        {clock(event.timestamp)}
      </time>
      <span className="row-span-2 flex self-start pt-0.5 @3xl:self-center @3xl:pt-0">
        <LeadMark event={event} />
      </span>

      {/* Title line. */}
      <span className="flex min-w-0 items-center gap-2 @3xl:flex-1">
        {showSource && (
          <span
            className={cn(
              "hidden w-[4.5rem] shrink-0 text-[11px] font-medium @5xl:inline",
              SOURCE_TEXT[event.source],
            )}
          >
            {SHORT_SOURCE[event.source]}
          </span>
        )}
        <span className="flex min-w-0 shrink items-center gap-1.5 overflow-hidden">
          <What event={event} />
        </span>
        <Meta event={event} className="hidden @5xl:flex" />
      </span>

      {/* Phone: time sits top right, like a mail list. */}
      <time
        dateTime={event.timestamp}
        className="font-mono text-[11px] text-muted-foreground tabular-nums @3xl:hidden"
      >
        {clock(event.timestamp)}
      </time>

      {/* Phone second line / narrow desktop: meta, then the numbers. */}
      <span className="col-span-2 flex min-w-0 items-center gap-3 @3xl:hidden">
        <Meta event={event} className="flex flex-1" />
        {tone && event.source !== "guardrails" && (
          <StatusPill status={event.status} />
        )}
        <Metrics event={event} compact />
      </span>

      <span className="hidden shrink-0 items-center gap-3 @3xl:flex">
        <span className="flex w-[6.5rem] justify-end">
          {tone && event.source !== "guardrails" && (
            <StatusPill status={event.status} />
          )}
        </span>
        <Metrics event={event} />
        <ChevronRight className="size-3.5 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground" />
      </span>
    </Link>
  );
}

export function DayHeader({
  iso,
  top,
  trailing,
}: {
  iso: string;
  top: number;
  /** Quiet right-aligned note, e.g. the event count on the first day. */
  trailing?: ReactNode;
}) {
  return (
    <div
      style={{ top }}
      className="sticky z-[5] flex h-7 items-center gap-2 border-b bg-muted px-3.5 text-[11px]"
    >
      <span className="font-medium">{dayName(iso)}</span>
      <span className="text-muted-foreground">
        {new Date(iso).toLocaleDateString([], {
          month: "short",
          day: "numeric",
        })}
      </span>
      {trailing && (
        <span className="ml-auto font-mono text-muted-foreground tabular-nums">
          {trailing}
        </span>
      )}
    </div>
  );
}

export function SkeletonRows({ count }: { count: number }) {
  return (
    <div className="divide-y divide-border/60">
      {Array.from({ length: count }, (_, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
          key={i}
          className="flex h-[52px] items-center gap-3 pr-3 pl-3.5 @3xl:h-[34px]"
        >
          <Skeleton className="hidden h-3 w-12 @3xl:block" />
          <Skeleton className="size-[18px] rounded-[5px]" />
          <Skeleton
            className="h-3"
            style={{ width: `${28 + ((i * 29) % 40)}%` }}
          />
          <Skeleton className="ml-auto h-3 w-16" />
        </div>
      ))}
    </div>
  );
}

export function sameDay(a: string, b: string) {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

// ===== cells =====

function LeadMark({ event }: { event: LogEvent }) {
  if (event.agent && event.source !== "audit") {
    return (
      <AgentIdenticon
        seed={event.agent.id}
        name={event.agent.name}
        variant="agent"
        size="sm"
      />
    );
  }
  const Icon = SOURCE_ICON[event.source];
  return (
    <span
      className={cn(
        "flex size-[18px] shrink-0 items-center justify-center rounded-[5px]",
        SOURCE_BY_ID[event.source].chip,
      )}
    >
      <Icon className="size-2.5" />
    </span>
  );
}

/** The headline, formatted for what each type is about. */
function What({ event }: { event: LogEvent }) {
  if (event.llm) {
    return (
      <>
        <MakerDisc
          provider={event.llm.provider}
          vendor={event.llm.provider}
          size={14}
          ring={false}
        />
        <Mono>{event.llm.model}</Mono>
        <Muted error={event.status === "error"}>
          {event.sessionTitle && event.status !== "error"
            ? event.sessionTitle
            : event.summary}
        </Muted>
      </>
    );
  }
  if (event.mcp) {
    const tool = event.mcp.tool
      ? stripServer(event.mcp.tool, event.mcp.server)
      : event.mcp.method;
    return (
      <>
        <ServerChip server={event.mcp.server} />
        <Mono>{tool}</Mono>
        <Muted error={event.status === "error"}>{event.summary}</Muted>
      </>
    );
  }
  if (event.guardrail) {
    const g = event.guardrail;
    return (
      <>
        <DecisionTag decision={g.decision} />
        <Mono>{g.tool}</Mono>
        <Muted>{g.decision === "yell" ? event.summary : g.reason}</Muted>
      </>
    );
  }
  if (event.connection) {
    const c = event.connection;
    return (
      <>
        <span className="truncate font-medium">{c.client}</span>
        <span className="shrink-0 text-muted-foreground">
          {CONNECTION_VERB[c.action]}
        </span>
        <span className="truncate font-medium">{c.gateway}</span>
      </>
    );
  }
  if (event.audit) {
    return (
      <>
        <span className="min-w-[3rem] truncate font-medium">
          {event.audit.action}
        </span>
        <span className="inline-flex min-w-0 items-center rounded border bg-background px-1.5 text-[11px] leading-[18px] text-muted-foreground">
          <span className="truncate">{event.audit.resourceName}</span>
        </span>
      </>
    );
  }
  return <span className="truncate font-medium">{event.title}</span>;
}

/** Who and from where: actor, agent, client, each led by its own icon. */
function Meta({ event, className }: { event: LogEvent; className?: string }) {
  const showAgent =
    event.agent && event.actor.kind !== "agent" && event.source !== "audit";
  const client = event.connection ? undefined : event.client;
  return (
    <span
      className={cn(
        "min-w-0 items-center gap-3 text-xs text-muted-foreground",
        className,
      )}
    >
      <span className="inline-flex min-w-0 items-center gap-1.5 text-foreground/80">
        <PersonAvatar name={event.actor.name} size={14} ring={false} />
        <span className="truncate">{event.actor.name}</span>
      </span>
      {showAgent && event.agent && (
        <MetaItem icon={Bot}>{event.agent.name}</MetaItem>
      )}
      {client && (
        <MetaItem icon={Laptop} className="hidden @6xl:inline-flex">
          {client}
        </MetaItem>
      )}
    </span>
  );
}

/** Right-aligned numbers with small icons: what you scan each type for. */
function Metrics({ event, compact }: { event: LogEvent; compact?: boolean }) {
  let content: ReactNode = null;
  if (event.llm) {
    const l = event.llm;
    content = (
      <>
        {l.toolCallsRequested > 0 && (
          <Metric
            icon={Wrench}
            tone="text-sky-500"
            title="Tool calls requested"
          >
            {l.toolCallsRequested}
          </Metric>
        )}
        <Metric icon={Sparkles} tone="text-violet-500" title="Tokens">
          {formatTokens(l.inputTokens + l.outputTokens)}
        </Metric>
        <span
          title={l.billingMode === "subscription" ? "Subscription" : "Cost"}
          className={cn(
            "w-12 text-right text-foreground/80",
            l.billingMode === "subscription" && "text-muted-foreground",
          )}
        >
          {formatCost(l.cost)}
        </span>
      </>
    );
  } else if (event.audit) {
    content = (
      <>
        <span>{event.audit.httpMethod}</span>
        <span
          className={cn(
            "w-7 text-right",
            event.audit.statusCode >= 400 && "text-red-600 dark:text-red-400",
          )}
        >
          {event.audit.statusCode}
        </span>
      </>
    );
  } else if (event.connection) {
    content = event.connection.clientVersion ? (
      <span>v{event.connection.clientVersion}</span>
    ) : null;
  } else if (event.durationMs != null) {
    content = (
      <Metric icon={Clock} title="Duration">
        {formatDuration(event.durationMs)}
      </Metric>
    );
  }
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-end gap-2.5 font-mono text-[11px] text-muted-foreground tabular-nums",
        !compact && "w-[9.5rem]",
      )}
    >
      {content}
    </span>
  );
}

function Metric({
  icon: Icon,
  tone,
  title,
  children,
}: {
  icon: LucideIcon;
  tone?: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <span title={title} className="inline-flex items-center gap-1">
      <Icon className={cn("size-3", tone ?? "opacity-70")} />
      <span>{children}</span>
    </span>
  );
}

function MetaItem({
  icon: Icon,
  children,
  className,
}: {
  icon: LucideIcon;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1", className)}>
      <Icon className="size-3 shrink-0 opacity-70" />
      <span className="truncate">{children}</span>
    </span>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return (
    <span className="min-w-[2.5rem] truncate font-mono text-[12.5px] font-medium">
      {children}
    </span>
  );
}

function Muted({ children, error }: { children?: ReactNode; error?: boolean }) {
  if (!children) return null;
  return (
    <span
      className={cn(
        "min-w-0 shrink-[8] truncate text-xs",
        // On a phone the title line keeps the name; errors still show.
        error
          ? "text-red-600 dark:text-red-400"
          : "hidden text-muted-foreground @md:inline",
      )}
    >
      {children}
    </span>
  );
}

function ServerChip({ server }: { server: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded border border-sky-500/30 bg-sky-500/10 px-1.5 text-[11px] leading-[18px] font-medium text-sky-700 dark:text-sky-300">
      <Wrench className="size-2.5" />
      <span>{server}</span>
    </span>
  );
}

function DecisionTag({
  decision,
}: {
  decision: NonNullable<LogEvent["guardrail"]>["decision"];
}) {
  const d = DECISION[decision];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded px-1.5 text-[11px] leading-[18px] font-medium",
        d.className,
      )}
    >
      {d.label}
    </span>
  );
}

function StatusPill({ status }: { status: LogStatus }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-1.5 text-[11px] leading-[18px] font-medium",
        PILL_TONE[status],
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function clock(iso: string) {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function dayName(iso: string) {
  const d = new Date(iso).toDateString();
  if (d === new Date().toDateString()) return "Today";
  if (d === new Date(Date.now() - 86_400_000).toDateString())
    return "Yesterday";
  return new Date(iso).toLocaleDateString([], { weekday: "long" });
}

function stripServer(tool: string, server: string) {
  const prefix = `${server}__`;
  return tool.startsWith(prefix) ? tool.slice(prefix.length) : tool;
}

const SOURCE_ICON: Record<LogSource, LucideIcon> = {
  llm: Sparkles,
  mcp: Wrench,
  guardrails: Shield,
  connections: Plug,
  audit: ScrollText,
};

const SHORT_SOURCE: Record<LogSource, string> = {
  llm: "LLM",
  mcp: "MCP",
  guardrails: "Guardrail",
  connections: "Connection",
  audit: "Audit",
};

const SOURCE_TEXT: Record<LogSource, string> = {
  llm: "text-violet-600 dark:text-violet-400",
  mcp: "text-sky-600 dark:text-sky-400",
  guardrails: "text-amber-600 dark:text-amber-400",
  connections: "text-emerald-600 dark:text-emerald-400",
  audit: "text-slate-600 dark:text-slate-400",
};

/** Rows with a problem get v2's accent and a faint tint. OK rows get none. */
const PROBLEM_TONE: Partial<
  Record<LogStatus, { accent: string; row: string }>
> = {
  error: {
    accent: "bg-red-500",
    row: "bg-red-500/[0.035] dark:bg-red-500/[0.06]",
  },
  blocked: {
    accent: "bg-orange-500",
    row: "bg-orange-500/[0.035] dark:bg-orange-500/[0.06]",
  },
  pending: {
    accent: "bg-amber-500",
    row: "bg-amber-500/[0.03] dark:bg-amber-500/[0.05]",
  },
  warning: {
    accent: "bg-yellow-500",
    row: "bg-yellow-500/[0.03] dark:bg-yellow-500/[0.05]",
  },
};

const PILL_TONE: Record<LogStatus, string> = {
  ok: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  error: "bg-red-500/10 text-red-700 dark:text-red-300",
  blocked: "bg-orange-500/10 text-orange-700 dark:text-orange-300",
  pending: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  warning: "bg-yellow-500/15 text-yellow-800 dark:text-yellow-300",
};

const DECISION = {
  allow: {
    label: "Allowed",
    className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  deny: {
    label: "Blocked",
    className: "bg-orange-500/10 text-orange-700 dark:text-orange-300",
  },
  review: {
    label: "Approval",
    className: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  },
  yell: {
    label: "Yell",
    className: "bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300",
  },
} as const;

const CONNECTION_VERB: Record<
  NonNullable<LogEvent["connection"]>["action"],
  string
> = {
  connected: "connected to",
  first_seen: "first seen on",
  authorized: "authorized on",
  token_refreshed: "refreshed token on",
  disconnected: "disconnected from",
};
