"use client";

import {
  ChevronLeft,
  ChevronRight,
  CornerDownRight,
  Eye,
  EyeOff,
  Lock,
  MessageSquareText,
  RotateCcw,
  Send,
  Shield,
  ShieldAlert,
  ShieldX,
} from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  describeModelOrigin,
  formatCompactNumber,
  formatRequestCost,
  formatUsageCost,
  shortModelName,
} from "@/app/llm/logs/_parts/logs-table-format";
import { MakerDisc } from "@/app/llm/logs/_parts/maker-disc";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { McpToolCallStatusIcon } from "@/components/mcp-tool-call-status";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import {
  MCP_TOOL_CALL_STATUS_LABELS,
  readMcpToolCall,
} from "@/lib/mcp-logs/tool-call-content";
import type { McpServerDisplay } from "@/lib/mcp-logs/use-mcp-server-display";
import { formatDate } from "@/lib/utils/date-time";
import { formatElapsed, formatLatency } from "@/lib/utils/format-duration";
import { cn } from "@/lib/utils/tailwind";
import {
  audienceTone,
  CONSULT_KIND,
  DECISION_TONE,
  type GuardrailsData,
  type LabelSegment,
  type LabelState,
  type TraceConsult,
  type TraceYell,
  trustTone,
} from "./guardrails";
import { DecisionIcon, DecisionTerm, RoleTerm } from "./guardrails-context";
import {
  type InteractionSummary,
  type RequestSpan,
  requestLabel,
  SPAN_KINDS,
  type SpanKind,
  type Timeline,
  type TimelineSpan,
  type ToolCallSpan,
} from "./session-timeline";
import { GRIDS, type Layout, WIDE_ONLY } from "./waterfall-grid";
import { YellStepper } from "./yell-markers";

// ============================================================================
// Guardrail rows
// ============================================================================

export type Entry =
  | {
      type: "span";
      key: string;
      span: TimelineSpan;
      gutter: LabelState | null;
      /** The tool call's checks, for the badge while they are hidden. */
      checks: TraceConsult[];
    }
  | {
      type: "consult";
      key: string;
      consult: TraceConsult;
      toolSpan: TimelineSpan | null;
      gutter: LabelState | null;
    };

export function buildEntries({
  spans,
  guardrails,
}: {
  spans: TimelineSpan[];
  guardrails: GuardrailsData | null;
}): Entry[] {
  if (!guardrails || spans.length === 0) {
    return spans.map((span) => ({
      type: "span",
      key: span.key,
      span,
      gutter: null,
      checks: [],
    }));
  }
  const { labelAt } = guardrails;
  const spanByKey = new Map(spans.map((span) => [span.key, span]));
  const pageStart = Math.min(...spans.map((span) => span.start));
  const pageEnd = Math.max(...spans.map((span) => span.end));

  const byTool = new Map<
    string,
    { before: TraceConsult[]; after: TraceConsult[] }
  >();
  const loose: TraceConsult[] = [];
  for (const consult of guardrails.consults) {
    if (consult.toolCallKey && spanByKey.has(consult.toolCallKey)) {
      const bucket = byTool.get(consult.toolCallKey) ?? {
        before: [],
        after: [],
      };
      (consult.beforeCall ? bucket.before : bucket.after).push(consult);
      byTool.set(consult.toolCallKey, bucket);
    } else if (
      !consult.toolCallKey &&
      consult.start >= pageStart &&
      consult.start <= pageEnd
    ) {
      loose.push(consult);
    }
  }

  const timed: { at: number; entry: Entry }[] = [];
  for (const consult of loose) {
    timed.push({
      at: consult.start,
      entry: consultEntry(consult, null, labelAt),
    });
  }
  timed.sort((a, b) => a.at - b.at);

  const out: Entry[] = [];
  let next = 0;
  for (const span of spans) {
    while (next < timed.length && timed[next].at <= span.start) {
      out.push(timed[next++].entry);
    }
    const bucket = byTool.get(span.key);
    if (bucket) {
      for (const c of bucket.before) out.push(consultEntry(c, span, labelAt));
    }
    out.push({
      type: "span",
      key: span.key,
      span,
      gutter: labelAt(span.start),
      checks: bucket ? [...bucket.before, ...bucket.after] : [],
    });
    if (bucket) {
      for (const c of bucket.after) out.push(consultEntry(c, span, labelAt));
    }
  }
  for (; next < timed.length; next++) out.push(timed[next].entry);
  return out;
}

function consultEntry(
  consult: TraceConsult,
  toolSpan: TimelineSpan | null,
  labelAt: (ms: number) => LabelState | null,
): Entry {
  return {
    type: "consult",
    key: consult.key,
    consult,
    toolSpan,
    gutter: labelAt(consult.start),
  };
}

export function pageConsults({
  spans,
  guardrails,
}: {
  spans: TimelineSpan[];
  guardrails: GuardrailsData;
}): TraceConsult[] {
  const keys = new Set(spans.map((span) => span.key));
  const pageStart = Math.min(...spans.map((span) => span.start));
  const pageEnd = Math.max(...spans.map((span) => span.end));
  return guardrails.consults.filter((c) =>
    c.toolCallKey
      ? keys.has(c.toolCallKey)
      : c.start >= pageStart && c.start <= pageEnd,
  );
}

/** "Blocked", or what went wrong when there was no answer. */
function decisionWord(consult: TraceConsult): { text: string; tone: string } {
  if (consult.outcome === "timeout") {
    return { text: "Timed out", tone: "text-amber-700 dark:text-amber-300" };
  }
  if (consult.outcome === "non_success") {
    return { text: "Failed", tone: "text-amber-700 dark:text-amber-300" };
  }
  const tone = DECISION_TONE[consult.decision];
  return { text: tone.label, tone: tone.text };
}

function checkedWhat(consult: TraceConsult): string {
  const tool = consult.toolName ?? "a tool call";
  return consult.beforeCall
    ? `checked before ${tool}`
    : `checked result of ${tool}`;
}

/**
 * The one-line strip under the header: the page's checks, the check-rows
 * toggle, the gutter's key, and a stepper through the label changes (each a
 * dot in the gutter). Phones put the key on a second line.
 */
export function GuardrailsBar({
  consults,
  changes,
  activeChange,
  onActivateChange,
  label,
  labelName,
  yells,
  selectedKey,
  onSelectYell,
}: {
  consults: TraceConsult[];
  changes: LabelChange[];
  /** Index of the change whose cause is selected, or -1. */
  activeChange: number;
  onActivateChange: (change: LabelChange) => void;
  label: LabelState | null;
  labelName: string;
  /** The page's yells whose calls are on it. */
  yells: TraceYell[];
  /** The selected span, when a span (not a check) is selected. */
  selectedKey: string | null;
  onSelectYell: (yell: TraceYell) => void;
}) {
  const blocked = consults.filter((c) => c.decision === "blocked").length;
  const unanswered = consults.filter((c) => c.outcome !== "answered").length;
  return (
    <div className="flex items-center gap-x-3 gap-y-0.5 overflow-x-auto border-b bg-muted/20 px-4 py-1 text-[11px] whitespace-nowrap text-muted-foreground [scrollbar-width:none] sm:flex-wrap sm:overflow-visible">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex h-7 cursor-default items-center gap-1.5 tabular-nums lg:h-6">
            <Shield
              className="size-3.5 text-foreground/70"
              aria-hidden="true"
            />
            <span>
              <span className="font-medium text-foreground/90">
                {consults.length}
              </span>{" "}
              <span className="max-sm:sr-only">
                guardrail {consults.length === 1 ? "check" : "checks"}
              </span>
            </span>
            {blocked > 0 ? (
              <span className="inline-flex items-center gap-0.5 font-medium text-rose-700 dark:text-rose-300">
                <ShieldX className="size-3" aria-hidden="true" />
                {blocked}
                <span className="max-sm:sr-only"> blocked</span>
              </span>
            ) : null}
            {unanswered > 0 ? (
              <span className="inline-flex items-center gap-0.5 text-amber-700 dark:text-amber-300">
                <ShieldAlert className="size-3" aria-hidden="true" />
                {unanswered}
                <span className="max-sm:sr-only"> unanswered</span>
              </span>
            ) : null}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          Guardrail checks on this page, each a row beside the tool call it
          guarded. Click one to open its details below.
        </TooltipContent>
      </Tooltip>
      {yells.length > 0 ? (
        <YellStepper
          yells={yells}
          selectedKey={selectedKey}
          onSelect={onSelectYell}
        />
      ) : null}
      <GutterKey />
      {label ? (
        <span
          className="hidden min-w-0 items-center gap-1.5 xl:ml-auto xl:inline-flex"
          title={`Label at ${labelName}`}
        >
          <span>Here</span>
          <GutterSwatch label={label} />
          <span className={cn("font-medium", trustTone(label.trust).text)}>
            {trustTone(label.trust).label}
          </span>
          <span aria-hidden="true" className="text-muted-foreground/50">
            ·
          </span>
          <span
            className={cn("font-medium", audienceTone(label.audience).text)}
          >
            {audienceTone(label.audience).label}
          </span>
        </span>
      ) : null}
      {changes.length > 0 ? (
        <ChangeStepper
          changes={changes}
          active={activeChange}
          onActivate={onActivateChange}
        />
      ) : null}
    </div>
  );
}

/** "‹ 2/3 changes ›": steps through the label changes, selecting each cause. */
function ChangeStepper({
  changes,
  active,
  onActivate,
}: {
  changes: LabelChange[];
  active: number;
  onActivate: (change: LabelChange) => void;
}) {
  const step = (delta: number) => {
    const from = active < 0 ? (delta > 0 ? -1 : 0) : active;
    onActivate(changes[(from + delta + changes.length) % changes.length]);
  };
  const arrow =
    "flex w-7 shrink-0 cursor-pointer items-center justify-center outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset lg:w-6";
  return (
    <span className="ml-auto inline-flex h-7 shrink-0 items-stretch overflow-hidden rounded-md border bg-card text-foreground/85 xl:ml-0 lg:h-6">
      <UnstyledButton
        aria-label="Previous label change"
        onClick={() => step(-1)}
        className={arrow}
      >
        <ChevronLeft className="size-3.5" aria-hidden="true" />
      </UnstyledButton>
      <Tooltip>
        <TooltipTrigger asChild>
          <UnstyledButton
            onClick={() => onActivate(changes[Math.max(0, active)])}
            aria-label={`${changes.length} label ${changes.length === 1 ? "change" : "changes"}${active >= 0 ? `, ${active + 1} selected: ${changeWords(changes[active])}` : ""}. Select its cause.`}
            className="inline-flex cursor-pointer items-center gap-1 border-x px-1.5 font-medium whitespace-nowrap tabular-nums outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                active >= 0 ? "bg-primary" : "bg-foreground/40",
              )}
            />
            <span>
              {active >= 0 ? (
                <>
                  {active + 1}
                  <span className="text-muted-foreground">
                    /{changes.length}
                  </span>
                </>
              ) : (
                changes.length
              )}{" "}
              <span className="max-lg:hidden">label </span>
              <span className="max-sm:hidden">
                {changes.length === 1 ? "change" : "changes"}
              </span>
            </span>
          </UnstyledButton>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end" className="max-w-xs">
          <ol className="space-y-0.5">
            {changes.map((change, index) => (
              <li
                key={change.key}
                className={cn(index === active ? "font-medium" : "opacity-80")}
              >
                {index + 1}. {changeWords(change)}{" "}
                <span className="opacity-70">· {causeShort(change)}</span>
              </li>
            ))}
          </ol>
          <p className="mt-1 opacity-70">
            Each is a dot in the left gutter. Step to select what caused it.
          </p>
        </TooltipContent>
      </Tooltip>
      <UnstyledButton
        aria-label="Next label change"
        onClick={() => step(1)}
        className={arrow}
      >
        <ChevronRight className="size-3.5" aria-hidden="true" />
      </UnstyledButton>
    </span>
  );
}

/** The gutter's key, in three words; the tooltip says the rest. */
function GutterKey() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <ul
          aria-label="Label gutter key: colour is trust, stripes mean the audience is narrowed"
          className="flex h-6 cursor-default items-center gap-x-2.5 whitespace-nowrap max-sm:hidden max-md:order-last max-md:basis-full"
        >
          <li className="text-muted-foreground/80">Left rail:</li>
          <li className="inline-flex items-center gap-1">
            <GutterSwatch label={{ trust: "trusted", audience: "public" }} />
            Trusted
          </li>
          <li className="inline-flex items-center gap-1">
            <GutterSwatch label={{ trust: "suspicious", audience: "public" }} />
            Suspicious
          </li>
          {/* Stripes lie over either trust colour, so the key shows them on
              the one a narrowed session most often has. */}
          <li className="inline-flex items-center gap-1">
            <GutterSwatch
              label={{ trust: "suspicious", audience: "internal" }}
            />
            Striped: narrowed audience
          </li>
          <li className="hidden items-center gap-1 xl:inline-flex">
            <span
              aria-hidden="true"
              className="size-2 rounded-full bg-foreground/60 ring-2 ring-card"
            />
            Change
          </li>
        </ul>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        The left gutter is the session label at each row. Its colour is trust;
        stripes mean the audience is narrower than public (internal, a team, or
        self). A dot marks where it changed: hover it for why.
      </TooltipContent>
    </Tooltip>
  );
}

function GutterSwatch({ label }: { label: LabelState | null }) {
  return (
    <span
      aria-hidden="true"
      className="relative h-3.5 w-2 shrink-0 overflow-hidden rounded-[2px] bg-card ring-1 ring-border/60"
    >
      <span
        className={cn(
          "absolute inset-0",
          label ? GUTTER_FILL[label.trust] : "bg-muted",
        )}
      />
      {!label || label.audience !== "public" ? <Stripes /> : null}
    </span>
  );
}

/**
 * Narrowed-audience stripes. One 8px tile anchored so every row's stripes
 * meet the next row's: lg rows are 40/32px (multiples of 8), phone rows
 * 44/36px, so every other phone row shifts the tile by half.
 */
function Stripes({ odd = false }: { odd?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "absolute inset-0 [--stripe:rgb(15_23_42/0.42)] dark:[--stripe:rgb(241_245_249/0.5)]",
        odd && "max-lg:[background-position:0_-4px]",
      )}
      style={STRIPE_STYLE}
    />
  );
}

export type GutterProps = {
  label: LabelState;
  /** Odd rows shift the stripe tile on phones; see `Stripes`. */
  odd: boolean;
  /** Change dots on this row's top or bottom edge. */
  nodes: { top: LabelChange[]; bottom: LabelChange[] } | null;
  isChangeActive: (change: LabelChange) => boolean;
  onActivateChange: (change: LabelChange) => void;
};

/**
 * The row's 8px label gutter: filled by trust, striped when the audience is
 * narrowed, with a 16px hover/tap target for its tooltip and a dot on the
 * edge where the label changed.
 */
export function LabelGutter({
  label,
  odd,
  nodes,
  isChangeActive,
  onActivateChange,
  onSelectRow,
}: GutterProps & { onSelectRow: () => void }) {
  const [open, setOpen] = useState(false);
  const narrowed = label.audience !== "public";
  return (
    <>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-0 z-[1] w-2 bg-card"
      >
        <span className={cn("absolute inset-0", GUTTER_FILL[label.trust])} />
        {narrowed ? <Stripes odd={odd} /> : null}
      </span>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <span
            aria-hidden="true"
            // A tap selects the row and keeps the tooltip open: touch has no
            // hover, and the trigger would close it on click and on leave.
            onClick={(event: MouseEvent<HTMLSpanElement>) => {
              event.preventDefault();
              onSelectRow();
              setOpen(true);
            }}
            onPointerLeave={(event: PointerEvent<HTMLSpanElement>) => {
              if (event.pointerType === "touch") event.preventDefault();
            }}
            className="absolute inset-y-0 left-0 z-[2] w-4 cursor-pointer"
          />
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-xs">
          <p>
            <span className="font-medium">Label</span>{" "}
            {trustTone(label.trust).label} ·{" "}
            {audienceTone(label.audience).label}
          </p>
          <p className="opacity-70">
            {narrowed
              ? `Striped: audience narrowed to ${audienceTone(label.audience).label.toLowerCase()}`
              : "Plain: audience is public"}
          </p>
        </TooltipContent>
      </Tooltip>
      {nodes && nodes.top.length > 0 ? (
        <ChangeNode
          at="top"
          changes={nodes.top}
          active={nodes.top.some(isChangeActive)}
          onActivate={onActivateChange}
        />
      ) : null}
      {nodes && nodes.bottom.length > 0 ? (
        <ChangeNode
          at="bottom"
          changes={nodes.bottom}
          active={nodes.bottom.some(isChangeActive)}
          onActivate={onActivateChange}
        />
      ) : null}
    </>
  );
}

/**
 * A label change: a dot on the gutter where the colour or stripes switch.
 * Solid in the new trust colour when trust moved (or the label reset),
 * hollow when only the audience did. Clicking selects the cause.
 */
function ChangeNode({
  at,
  changes,
  active,
  onActivate,
}: {
  at: "top" | "bottom";
  changes: LabelChange[];
  active: boolean;
  onActivate: (change: LabelChange) => void;
}) {
  const last = changes[changes.length - 1];
  const solid = changes.some((c) => c.trustChanged);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          tabIndex={-1}
          onClick={() => onActivate(last)}
          aria-label={`Label changed: ${changes.map(changeWords).join("; ")}. Select its cause.`}
          className={cn(
            "group/node absolute left-0 z-[4] flex size-4 cursor-pointer items-center outline-none",
            at === "top"
              ? "top-0 -translate-y-1/2"
              : "bottom-0 translate-y-1/2",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-2.5 rounded-full ring-2 ring-card transition-transform group-hover/node:scale-125",
              solid
                ? trustTone(last.segment.trust).bar
                : "bg-card shadow-[inset_0_0_0_2px_var(--color-foreground)] opacity-90",
              active && "outline-2 outline-offset-1 outline-primary",
            )}
          />
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-xs">
        {changes.map((change) => (
          <div key={change.key}>
            <p className="font-medium">{changeWords(change)}</p>
            <p className="opacity-80">{change.cause.summary}</p>
          </div>
        ))}
        <p className="mt-0.5 opacity-70">Click to select its cause</p>
      </TooltipContent>
    </Tooltip>
  );
}

/** "· 🔒 Audience → Internal" on the cause row's detail line. */
export function ChangeNote({ changes }: { changes: LabelChange[] }) {
  return (
    <span className="inline-flex min-w-0 shrink items-center gap-1 overflow-hidden whitespace-nowrap">
      <span aria-hidden="true" className="shrink-0 text-muted-foreground/40">
        ·
      </span>
      {changes.map((change) => {
        const Icon = CHANGE_ICON[change.cause.kind];
        return (
          <span
            key={change.key}
            className="inline-flex shrink-0 items-center gap-1 text-muted-foreground"
          >
            <Icon className="size-3 shrink-0 opacity-80" aria-hidden="true" />
            {change.parts.map((part, index) => (
              <span key={part.field} className="inline-flex items-center gap-1">
                {index > 0 ? <span className="opacity-50">,</span> : null}
                {/* Phones keep the new value; the icon says which kind. */}
                <span className="max-lg:hidden">{part.field}</span>
                <span aria-hidden="true" className="opacity-60">
                  →
                </span>
                <span className={cn("font-medium opacity-90", part.tone)}>
                  {part.to}
                </span>
              </span>
            ))}
          </span>
        );
      })}
    </span>
  );
}

/** The row's label in words, and what it changed, for its accessible name. */
export function gutterWords(
  gutter: GutterProps | null,
  note: LabelChange[] | null,
): string {
  if (!gutter) return "";
  const here = `, label ${trustTone(gutter.label.trust).label} ${audienceTone(gutter.label.audience).label}`;
  return note && note.length > 0
    ? `${here}, changed the label: ${note.map(changeWords).join("; ")}`
    : here;
}

/**
 * A guardrail check as its own compact row under (or, for a gate, above)
 * its tool call: the whole row opens it in the pane below.
 */
export function ConsultRow({
  layout,
  consult,
  toolSpan,
  gutter,
  note,
  selected,
  buttonRef,
  onSelect,
}: {
  layout: Layout;
  consult: TraceConsult;
  toolSpan: TimelineSpan | null;
  gutter: GutterProps | null;
  note: LabelChange[] | null;
  selected: boolean;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onSelect: () => void;
}) {
  const decision = decisionWord(consult);
  const duration = formatLatency(consult.durationMs);
  const what = checkedWhat(consult);
  // A dotted lead between the check and the call it guards.
  const lead = toolSpan
    ? consult.beforeCall
      ? { from: consult.x + consult.w, to: toolSpan.x }
      : { from: toolSpan.x + toolSpan.w, to: consult.x }
    : null;
  const tools = layout === "tools";
  return (
    <li className="relative">
      {gutter ? <LabelGutter {...gutter} onSelectRow={onSelect} /> : null}
      <UnstyledButton
        ref={buttonRef}
        tabIndex={selected ? 0 : -1}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        aria-label={`Guardrail check ${consult.externalName}, ${what}: ${decision.text}${gutterWords(gutter, note)}. Opens its details below.`}
        className={cn(
          "group grid h-9 w-full cursor-pointer scroll-mt-8 scroll-mb-1 border-b border-border/40 text-left text-xs outline-none transition-colors duration-100 lg:h-8",
          GRIDS[layout],
          selected
            ? cn(
                "bg-primary/[0.07]",
                gutter ? SELECTED_PAST_GUTTER : SELECTED_EDGE,
              )
            : "bg-muted/25 hover:bg-muted/70",
          "focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
        )}
      >
        {/* Nested by the shield alone, 8px past the tool name: a thin stem
            under the tool call's rail ties the check to its call. Line 1
            is the verdict as a sentence; line 2 the role, when and how
            long. */}
        <span className="flex min-w-0 items-center pr-3 pl-4">
          <span
            aria-hidden="true"
            className="flex w-[3px] shrink-0 justify-center self-stretch"
          >
            <span
              className={cn(
                "w-px bg-border",
                consult.beforeCall ? "mt-2" : "mb-2",
              )}
            />
          </span>
          <DecisionIcon
            consult={consult}
            className={cn(
              "mr-1.5 ml-3.5",
              selected && consult.decision !== "blocked" && "text-foreground",
            )}
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-baseline gap-1 text-[11.5px] leading-4">
              {consult.outcome !== "answered" ? (
                <>
                  <span
                    className={cn("shrink-0 font-medium", decision.tone)}
                    title={
                      consult.outcome === "timeout"
                        ? "The check did not answer in time; the policy's fallback decided."
                        : "The check failed to answer; the policy's fallback decided."
                    }
                  >
                    {decision.text}
                  </span>
                  <span
                    aria-hidden="true"
                    className="shrink-0 text-muted-foreground/50"
                  >
                    ·
                  </span>
                </>
              ) : null}
              <DecisionTerm
                decision={consult.decision}
                className="shrink-0 font-medium"
              />
              <span className="shrink-0 text-muted-foreground">by</span>
              <span className="min-w-0 truncate font-mono font-medium">
                {consult.externalName}
              </span>
            </span>
            <span
              className={cn(
                "flex min-w-0 items-center gap-1 text-[10.5px] leading-[14px]",
                selected ? "text-foreground/70" : "text-muted-foreground",
              )}
            >
              <span className="min-w-0 truncate">
                <RoleTerm role={consult.role} />
                <span aria-hidden="true" className="opacity-50">
                  {" · "}
                </span>
                {consult.beforeCall ? "before the call" : "on the result"}
                <span aria-hidden="true" className="opacity-50">
                  {" · "}
                </span>
                <span className="tabular-nums">{duration}</span>
              </span>
              {note && note.length > 0 ? <ChangeNote changes={note} /> : null}
            </span>
          </span>
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground group-focus-visible:text-muted-foreground max-lg:hidden",
              selected && "text-primary/70",
            )}
          />
        </span>

        <span className="relative mx-2 block lg:mx-3">
          {lead && lead.to > lead.from ? (
            <span
              aria-hidden="true"
              className="absolute top-1/2 border-t border-dotted border-muted-foreground/40"
              style={{
                left: `${lead.from * 100}%`,
                width: `${(lead.to - lead.from) * 100}%`,
              }}
            />
          ) : null}
          <span
            aria-hidden="true"
            className={cn(
              "absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full",
              CONSULT_KIND.bar,
              consult.decision !== "blocked" && "opacity-80",
              selected && "ring-2 ring-offset-1 ring-offset-card",
              selected && CONSULT_KIND.ring,
            )}
            style={{
              left: `${consult.x * 100}%`,
              width: `max(4px, ${consult.w * 100}%)`,
            }}
          />
        </span>

        {/* Tokens and Cost: a check spends neither. */}
        {tools ? null : <span aria-hidden="true" className={WIDE_ONLY} />}
        <span aria-hidden="true" />
      </UnstyledButton>
    </li>
  );
}

export type LabelChange = {
  key: string;
  /** The segment the change starts. */
  segment: LabelSegment;
  cause: NonNullable<LabelSegment["cause"]>;
  /** What changed, in words: Trust → Suspicious, Audience → Internal. */
  parts: { field: string; to: string; tone: string }[];
  trustChanged: boolean;
  /** The row whose detail line notes it: the cause, else the first row under it. */
  noteKey: string;
  /** The row whose top (or, past the page's last row, bottom) edge carries the dot. */
  nodeKey: string;
  nodeAt: "top" | "bottom";
  /** What selecting the change selects. */
  target: { type: "consult" | "span"; key: string };
};

/**
 * The label changes this page shows: a dot wherever two rows' labels differ,
 * and a note on the row that caused each one.
 */
export function pageChanges({
  entries,
  guardrails,
}: {
  entries: Entry[];
  guardrails: GuardrailsData;
}): LabelChange[] {
  const { labels } = guardrails;
  if (entries.length === 0) return [];
  const drawn = new Map(entries.map((entry) => [entry.key, entry]));
  const rowFor = (key: string | null) => (key ? drawn.get(key) : undefined);
  const out: LabelChange[] = [];
  const add = (index: number, nodeEntry: Entry, nodeAt: "top" | "bottom") => {
    const segment = labels[index];
    const { cause } = segment;
    if (!cause) return;
    const prev = labels[index - 1];
    // The cause tool call carries the note and is what selecting the change
    // selects: its details explain why the label changed. A check with no
    // tool call drawn stands in for it.
    const noteEntry =
      rowFor(cause.toolCallKey) ?? rowFor(cause.consultKey) ?? nodeEntry;
    out.push({
      key: `label-change-${segment.start}`,
      segment,
      cause,
      parts: describeChange(prev, segment),
      trustChanged: cause.kind === "reset" || prev.trust !== segment.trust,
      noteKey: noteEntry.key,
      nodeKey: nodeEntry.key,
      nodeAt,
      target:
        noteEntry.type === "span"
          ? { type: "span", key: noteEntry.key }
          : { type: "consult", key: cause.consultKey ?? noteEntry.key },
    });
  };
  const indexes = entries.map((entry) =>
    segmentIndexAt(
      labels,
      entry.type === "span" ? entry.span.start : entry.consult.start,
    ),
  );
  // Rows run in start order but a result check can trail a parallel call:
  // each change is placed once, at the first row under it.
  let reached = indexes[0];
  entries.forEach((entry, i) => {
    for (let s = reached + 1; s <= indexes[i]; s++) add(s, entry, "top");
    reached = Math.max(reached, indexes[i]);
  });
  // A change after the page's last row still shows under its cause.
  for (let s = reached + 1; s < labels.length; s++) {
    const cause = labels[s].cause;
    const row = cause
      ? (rowFor(cause.consultKey) ?? rowFor(cause.toolCallKey))
      : undefined;
    if (row) add(s, row, "bottom");
  }
  return out;
}

function segmentIndexAt(labels: LabelSegment[], ms: number): number {
  let hit = 0;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i].start <= ms) hit = i;
    else break;
  }
  return hit;
}

function describeChange(
  prev: LabelSegment,
  next: LabelSegment,
): LabelChange["parts"] {
  if (next.cause?.kind === "reset") {
    return [
      {
        field: "Reset",
        to: `${trustTone(next.trust).label} · ${audienceTone(next.audience).label}`,
        tone: "text-foreground/80",
      },
    ];
  }
  const parts: LabelChange["parts"] = [];
  if (prev.trust !== next.trust) {
    parts.push({
      field: "Trust",
      to: trustTone(next.trust).label,
      tone: trustTone(next.trust).text,
    });
  }
  if (prev.audience !== next.audience) {
    parts.push({
      field: "Audience",
      to: audienceTone(next.audience).label,
      tone: audienceTone(next.audience).text,
    });
  }
  return parts.length > 0
    ? parts
    : [{ field: "Label", to: "set", tone: "text-foreground/80" }];
}

function changeWords(change: LabelChange): string {
  return change.parts.map((p) => `${p.field} → ${p.to}`).join(", ");
}

function causeShort(change: LabelChange): string {
  const { cause } = change;
  if (!cause.toolName) return "reset";
  return cause.kind === "reset"
    ? `reset by ${cause.toolName}`
    : `after ${cause.toolName}`;
}

export const SELECTED_EDGE = "shadow-[inset_2px_0_0_var(--color-primary)]";
/** The selection's edge just right of the 8px gutter, which covers 0–8px. */
export const SELECTED_PAST_GUTTER =
  "shadow-[inset_10px_0_0_var(--color-primary)]";
const GUTTER_FILL: Record<LabelState["trust"], string> = {
  trusted: "bg-emerald-500/40 dark:bg-emerald-400/35",
  suspicious: "bg-rose-500/70 dark:bg-rose-400/65",
};
const STRIPE_STYLE = {
  backgroundImage:
    "linear-gradient(135deg, var(--stripe) 25%, transparent 25%, transparent 50%, var(--stripe) 50%, var(--stripe) 75%, transparent 75%, transparent)",
  backgroundSize: "8px 8px",
};
const CHANGE_ICON: Record<
  NonNullable<LabelSegment["cause"]>["kind"],
  typeof ShieldAlert
> = {
  admitted: ShieldAlert,
  narrowed: Lock,
  released: Send,
  reset: RotateCcw,
};
