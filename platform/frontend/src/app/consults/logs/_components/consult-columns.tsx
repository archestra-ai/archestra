"use client";

import { isEncryptedChatUnavailableContent } from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import { Check, Clock, type LucideIcon, X } from "lucide-react";
import type { ReactNode } from "react";
import { AgentIdenticon } from "@/app/llm/logs/_parts/hue-avatar";
import { formatSessionSpan } from "@/app/llm/logs/_parts/logs-table-format";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { formatCompactRelativeTime, formatDate } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import type { ConsultView } from "./consult-details";
import { OUTCOME_LABEL } from "./consult-outcome-badge";

/**
 * The consults table's columns. The latency bar is scaled against the slowest
 * consult on the page, so the caller passes that in.
 */
export function buildConsultColumns(maxMs: number): ColumnDef<ConsultView>[] {
  return [
    {
      id: "service",
      header: "Service",
      size: 300,
      minSize: 240,
      cell: ({ row }) => <ServiceCell view={row.original} />,
    },
    {
      id: "tool",
      header: "Tool call",
      size: 280,
      minSize: 220,
      cell: ({ row }) => <ToolCell view={row.original} />,
    },
    {
      id: "signal",
      header: () => <div className="text-right">Signal</div>,
      size: 150,
      minSize: 140,
      cell: ({ row }) => <SignalCell view={row.original} />,
    },
    {
      id: "latency",
      header: () => <div className="text-right">Latency</div>,
      size: 136,
      minSize: 128,
      cell: ({ row }) => <LatencyCell view={row.original} maxMs={maxMs} />,
    },
    {
      id: "time",
      header: () => <div className="text-right">Time</div>,
      size: 128,
      minSize: 120,
      cell: ({ row }) => <TimeCell view={row.original} />,
    },
  ];
}

// ============================================================================
// Internal helpers
// ============================================================================

function ServiceCell({ view }: { view: ConsultView }) {
  const { consult } = view;
  const tone = toneOf(consult.outcome);
  const role = consult.role.replaceAll("_", " ");
  const backend = BACKEND_LABEL[consult.backend] ?? consult.backend;
  return (
    <div className="relative flex min-w-0 items-center gap-3">
      {tone === "fail" ? (
        <span
          aria-hidden="true"
          className="absolute top-1/2 -left-3 h-9 w-[3px] -translate-y-1/2 rounded-full bg-destructive"
        />
      ) : null}
      <OutcomeTile view={view} role={role} backend={backend} />
      <div className="min-w-0 flex-1">
        <div
          className="truncate text-sm leading-5 font-medium"
          title={consult.externalName}
        >
          {consult.externalName}
        </div>
        <div className="flex h-4 min-w-0 items-center gap-1 text-xs leading-4 text-muted-foreground">
          {tone !== "ok" ? (
            <>
              <span className={cn("shrink-0 font-medium", WORD_TONE[tone])}>
                {OUTCOME_WORD[consult.outcome] ??
                  OUTCOME_LABEL[consult.outcome]}
              </span>
              <Dot />
            </>
          ) : null}
          <span className="truncate capitalize">{role}</span>
          <span className="shrink-0 text-muted-foreground/70">via</span>
          <span className="shrink-0 truncate">{backend}</span>
        </div>
      </div>
    </div>
  );
}

/** The service's hue tile with its outcome pinned bottom-right. */
function OutcomeTile({
  view,
  role,
  backend,
}: {
  view: ConsultView;
  role: string;
  backend: string;
}) {
  const { consult } = view;
  const tone = toneOf(consult.outcome);
  const Icon = TONE_ICON[tone];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          aria-label={`${consult.externalName}: ${OUTCOME_LABEL[consult.outcome]}`}
          className="relative block size-8 shrink-0 cursor-default"
        >
          <AgentIdenticon
            seed={consult.externalName}
            name={consult.externalName}
            variant="agent"
          />
          <span className="absolute -right-1.5 -bottom-1.5 flex size-[18px] rounded-full bg-background ring-2 ring-background">
            <span
              className={cn(
                "flex size-full items-center justify-center rounded-full",
                BADGE_TONE[tone],
              )}
            >
              <Icon className="size-2.5" strokeWidth={3} aria-hidden="true" />
            </span>
          </span>
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs px-2 py-1.5">
        <div className="mb-1 flex items-center gap-1.5 font-medium">
          <Icon
            className={cn("size-3", ICON_TONE[tone])}
            strokeWidth={2.5}
            aria-hidden="true"
          />
          <span>{OUTCOME_LABEL[consult.outcome]}</span>
        </div>
        <div className="mb-1.5 flex min-w-0 items-center gap-1 text-muted-foreground">
          {outcomeDetail(view)}
        </div>
        <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
          <dt className="text-muted-foreground">Role</dt>
          <dd className="text-right capitalize">{role}</dd>
          <dt className="text-muted-foreground">Backend</dt>
          <dd className="text-right">{backend}</dd>
        </dl>
      </TooltipContent>
    </Tooltip>
  );
}

function ToolCell({ view }: { view: ConsultView }) {
  const call = view.toolCall;
  if (!call) {
    return (
      <div className="min-w-0">
        <div className="truncate text-sm leading-5 text-muted-foreground italic">
          No tool context
        </div>
        <div className="h-4 truncate text-xs leading-4 text-muted-foreground/70">
          {view.consult.role.replaceAll("_", " ")} consult
        </div>
      </div>
    );
  }
  const [server, ...rest] = call.name.split("__");
  const tool = rest.length > 0 ? rest.join("__") : server;
  const args = argsPreview(call.arguments);
  return (
    <div className="min-w-0" title={call.name}>
      <div className="truncate font-mono text-[13px] leading-5 font-medium">
        {tool}
      </div>
      <div className="flex h-4 min-w-0 items-center gap-1 font-mono text-[11px] leading-4 text-muted-foreground">
        {rest.length > 0 ? (
          <span className="shrink-0 text-foreground/70">{server}</span>
        ) : null}
        {args ? (
          <>
            <Dot />
            <span className="truncate">{args}</span>
          </>
        ) : null}
      </div>
    </div>
  );
}

function SignalCell({ view }: { view: ConsultView }) {
  const { consult, diagnostics } = view;
  const trusted =
    diagnostics.kind === "jev"
      ? diagnostics.jev.labels.requires_trusted
      : undefined;

  if (diagnostics.kind === "jev" && trusted && trusted.probability !== null) {
    const p = trusted.probability;
    const over = p >= trusted.threshold;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <UnstyledButton className="ml-auto block cursor-default text-right tabular-nums">
            <span className="flex items-center justify-end gap-2 text-sm leading-5">
              {over ? <Tag>Over cutoff</Tag> : null}
              <span className="font-medium">{Math.round(p * 100)}%</span>
            </span>
            <span className="flex h-4 items-center justify-end">
              <Meter value={p} threshold={trusted.threshold} hot={over} />
            </span>
          </UnstyledButton>
        </TooltipTrigger>
        <TooltipContent className="px-2 py-1.5">
          <div className="mb-1 text-muted-foreground">
            Requires trusted context
          </div>
          <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 tabular-nums">
            <dt className="text-muted-foreground">Probability</dt>
            <dd className="text-right">{p.toFixed(2)}</dd>
            <dt className="text-muted-foreground">Cutoff</dt>
            <dd className="text-right">{trusted.threshold.toFixed(2)}</dd>
            <dt className="text-muted-foreground">Decision</dt>
            <dd className="text-right">{over ? "Requires trusted" : "No"}</dd>
            <dt className="text-muted-foreground">Model</dt>
            <dd className="text-right">{diagnostics.jev.model}</dd>
            <dt className="text-muted-foreground">Classifier time</dt>
            <dd className="text-right">{diagnostics.jev.elapsed_ms}ms</dd>
          </dl>
        </TooltipContent>
      </Tooltip>
    );
  }

  if (consult.httpStatus) {
    const ok = consult.httpStatus < 400;
    return (
      <div className="text-right tabular-nums">
        <div
          className={cn(
            "text-sm leading-5 font-medium",
            !ok && "text-destructive",
          )}
        >
          {consult.httpStatus}
        </div>
        <div className="h-4 text-xs leading-4 whitespace-nowrap text-muted-foreground">
          HTTP {HTTP_TEXT[consult.httpStatus] ?? (ok ? "OK" : "error")}
        </div>
      </div>
    );
  }

  return (
    <div className="text-right">
      <div className="text-sm leading-5 text-muted-foreground/60">—</div>
      <div className="h-4 text-xs leading-4 text-muted-foreground/60">
        no signal
      </div>
    </div>
  );
}

function LatencyCell({ view, maxMs }: { view: ConsultView; maxMs: number }) {
  const ms = view.consult.durationMs ?? 0;
  const tone = toneOf(view.consult.outcome);
  // Log scale: one human approval would otherwise flatten every other bar.
  const ratio = Math.log10(ms + 1) / Math.log10(maxMs + 1);
  const isHuman = view.consult.backend === "hitl";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton className="ml-auto block cursor-default text-right tabular-nums">
          <span className="flex items-center justify-end gap-1.5 text-sm leading-5 whitespace-nowrap">
            {isHuman ? <Tag>Human</Tag> : null}
            <span className="font-medium">{formatMs(ms)}</span>
          </span>
          <span className="flex h-4 items-center justify-end">
            <span className="relative h-1 w-16 overflow-hidden rounded-full bg-border">
              <span
                className={cn(
                  "absolute inset-y-0 right-0 rounded-full",
                  tone === "ok" && "bg-muted-foreground/40",
                  tone === "warn" && "bg-amber-500",
                  tone === "fail" && "bg-destructive",
                )}
                style={{ width: `${Math.max(6, ratio * 100)}%` }}
              />
            </span>
          </span>
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent className="px-2 py-1.5">
        <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 tabular-nums">
          <dt className="text-muted-foreground">Duration</dt>
          <dd className="text-right">{ms.toLocaleString()}ms</dd>
          <dt className="text-muted-foreground">Slowest on page</dt>
          <dd className="text-right">{formatMs(maxMs)}</dd>
        </dl>
        <div className="mt-1 text-muted-foreground">Bar is log-scaled</div>
      </TooltipContent>
    </Tooltip>
  );
}

function TimeCell({ view }: { view: ConsultView }) {
  const { consult } = view;
  const end = new Date(
    new Date(consult.startedAt).getTime() + (consult.durationMs ?? 0),
  ).toISOString();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton className="ml-auto block cursor-default text-right tabular-nums">
          <time
            dateTime={consult.createdAt}
            className="block text-sm leading-5"
          >
            {formatCompactRelativeTime(consult.createdAt)}
          </time>
          <span className="block font-mono text-[11px] leading-4 whitespace-nowrap text-muted-foreground">
            {consult.sessionId ? shortId(consult.sessionId) : "no session"}
          </span>
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent className="px-2 py-1.5">
        <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 tabular-nums">
          <dt className="text-muted-foreground">Started</dt>
          <dd className="text-right">
            {formatDate({ date: consult.startedAt })}
          </dd>
          <dt className="text-muted-foreground">Took</dt>
          <dd className="text-right">
            {formatSessionSpan(consult.startedAt, end)}
          </dd>
          {consult.sessionId ? (
            <>
              <dt className="text-muted-foreground">Session</dt>
              <dd className="text-right font-mono">{consult.sessionId}</dd>
            </>
          ) : null}
          {consult.callId ? (
            <>
              <dt className="text-muted-foreground">Call</dt>
              <dd className="text-right font-mono">{consult.callId}</dd>
            </>
          ) : null}
        </dl>
      </TooltipContent>
    </Tooltip>
  );
}

type Tone = "ok" | "warn" | "fail";
type Outcome = ConsultView["consult"]["outcome"];

function toneOf(outcome: Outcome): Tone {
  if (outcome === "answered") return "ok";
  if (outcome === "timeout" || outcome === "dismissed") return "warn";
  return "fail";
}

const TONE_ICON: Record<Tone, LucideIcon> = { ok: Check, warn: Clock, fail: X };

// Opaque fills: the badge overlaps the hue tile, so a translucent tint would
// pick up the tile's color underneath.
const BADGE_TONE: Record<Tone, string> = {
  ok: "bg-muted text-muted-foreground",
  warn: "bg-amber-500/15 text-amber-600 dark:bg-amber-400/20 dark:text-amber-300",
  fail: "bg-destructive/15 text-destructive dark:bg-destructive/30",
};

const ICON_TONE: Record<Tone, string> = {
  ok: "text-muted-foreground",
  warn: "text-amber-600 dark:text-amber-400",
  fail: "text-destructive",
};

const WORD_TONE: Record<Tone, string> = {
  ok: "",
  warn: "text-amber-600 dark:text-amber-400",
  fail: "text-destructive",
};

// Short words for the Service line; anything missing falls back to the label.
const OUTCOME_WORD: Partial<Record<Outcome, string>> = {
  timeout: "Timed out",
  dismissed: "Dismissed",
  unreachable: "Unreachable",
  non_success: "Errored",
  malformed: "Malformed reply",
  module_error: "Module error",
  module_panicked: "Module panicked",
};

const BACKEND_LABEL: Record<string, string> = {
  url: "HTTP",
  command: "Command",
  module: "Module",
  llm: "LLM",
  jev: "Jev",
  claude_code: "Claude Code",
  hitl: "Human review",
  archestra: "Archestra",
};

const HTTP_TEXT: Record<number, string> = {
  200: "OK",
  201: "Created",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  429: "Too Many Requests",
  500: "Server Error",
  502: "Bad Gateway",
  503: "Unavailable",
  504: "Gateway Timeout",
};

function outcomeDetail(view: ConsultView) {
  const { consult } = view;
  switch (consult.outcome) {
    case "answered": {
      const answer = consult.answer;
      if (answer && typeof answer === "object") {
        const [entry] = Object.entries(answer as Record<string, unknown>);
        if (entry) {
          return (
            <>
              <span className="shrink-0">{entry[0]}</span>
              <span className="shrink-0 text-muted-foreground/70">→</span>
              <span className="truncate text-foreground/80">
                {String(entry[1])}
              </span>
            </>
          );
        }
      }
      return <span className="truncate">Service replied</span>;
    }
    case "timeout":
      return (
        <span className="truncate">
          No reply within {formatMs(consult.durationMs ?? 0)}
        </span>
      );
    case "dismissed":
      return (
        <span className="truncate">
          {consult.backend === "hitl"
            ? "Closed with no decision"
            : "Dismissed before replying"}
        </span>
      );
    case "unreachable":
      return <span className="truncate">Could not connect</span>;
    case "non_success":
      return <span className="truncate">Service returned an error</span>;
    case "malformed":
      return <span className="truncate">Reply failed schema check</span>;
    case "module_error":
    case "module_panicked":
      return (
        <span className="truncate font-mono text-[11px]">
          {view.diagnostics.kind === "text"
            ? view.diagnostics.text.split("\n")[0]
            : view.diagnostics.kind === "json" &&
                typeof view.diagnostics.value === "string"
              ? view.diagnostics.value
              : "Module failed"}
        </span>
      );
    default:
      return <span className="truncate">No usable reply</span>;
  }
}

function argsPreview(args: unknown): string | null {
  // Withheld arguments (metadata-only logging, locked chats) show nothing here;
  // the detail sheet says why.
  if (
    !args ||
    typeof args !== "object" ||
    isEncryptedChatUnavailableContent(args)
  ) {
    return null;
  }
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return null;
  return entries
    .map(
      ([key, value]) =>
        `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
    )
    .join("  ");
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 12)}…` : id;
}

function Meter({
  value,
  threshold,
  hot,
}: {
  value: number;
  threshold: number;
  hot: boolean;
}) {
  return (
    <span className="relative h-1 w-16 rounded-full bg-border">
      <span
        className={cn(
          "absolute inset-y-0 left-0 rounded-full",
          hot ? "bg-foreground/70" : "bg-muted-foreground/40",
        )}
        style={{ width: `${Math.max(4, value * 100)}%` }}
      />
      <span
        aria-hidden="true"
        className="absolute w-px bg-foreground/40"
        style={{ left: `${threshold * 100}%`, top: -2, bottom: -2 }}
      />
    </span>
  );
}

function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-sm bg-muted px-1 text-[10px] leading-4 font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </span>
  );
}

function Dot() {
  return (
    <span aria-hidden="true" className="shrink-0 text-muted-foreground/50">
      ·
    </span>
  );
}
