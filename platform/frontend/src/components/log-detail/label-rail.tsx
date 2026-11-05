"use client";

import {
  ChevronLeft,
  ChevronRight,
  Lock,
  LockOpen,
  RotateCcw,
  Shield,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import {
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useState,
} from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";
import type { GutterProps, LabelChange } from "./guardrail-rows";
import { audienceTone, type LabelState, trustTone } from "./guardrails";

// The session label beside every row of the trace: a rail of two lanes, trust
// on the left and audience on the right, with a shield or lock marker on the
// rail where the label changed. The strip's key and the cause row's note use
// the same colours and icons.

/** The strip's key: both lanes and their values, the label here, and a stepper through the changes. */
export function LabelLegend({
  label,
  labelName,
  changes,
  activeChange,
  onActivateChange,
}: {
  /** The label at the selected row, or at the page's end. */
  label: LabelState | null;
  labelName: string;
  changes: LabelChange[];
  /** Index of the change whose cause is selected, or -1. */
  activeChange: number;
  onActivateChange: (change: LabelChange) => void;
}) {
  const trusts = unique([
    "trusted",
    "suspicious",
    ...changes.map((c) => c.segment.trust),
    ...(label ? [label.trust] : []),
  ]);
  const audiences = unique([
    "public",
    "internal",
    "self",
    ...changes.map((c) => c.segment.audience),
    ...(label ? [label.audience] : []),
  ]);
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="note"
            aria-label={`Session label key. The strip at the left of each row has two lanes: trust (${trusts.map((t) => trustTone(t).label).join(", ")}) and audience (${audiences.map((a) => audienceTone(a).label).join(", ")}). A shield or lock on the strip marks where the label changed.`}
            className="flex h-6 cursor-default items-center gap-x-3 whitespace-nowrap max-sm:hidden max-md:order-last max-md:basis-full"
          >
            <span className="font-medium text-foreground/80">
              Session label
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Shield
                className="size-3 text-foreground/60"
                aria-hidden="true"
              />
              <span className="text-muted-foreground/80">Trust</span>
              {trusts.map((trust) => (
                <KeyValue
                  key={trust}
                  swatch={trustLane(trust)}
                  text={trustTone(trust).label}
                />
              ))}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Lock className="size-3 text-foreground/60" aria-hidden="true" />
              <span className="text-muted-foreground/80">Audience</span>
              {audiences.map((audience) => (
                <KeyValue
                  key={audience}
                  swatch={audienceLane(audience)}
                  text={audienceTone(audience).label}
                />
              ))}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs text-left">
          <p>
            The strip at the left of each row is the session label at that
            point. Its left lane is trust. Its right lane is the audience the
            agent's output may reach.
          </p>
          <p className="mt-1 opacity-70">
            Sessions normally start Trusted and Public. A shield or lock on the
            strip marks where the label changed. Hover it to see why.
          </p>
        </TooltipContent>
      </Tooltip>
      {label ? (
        <span
          className="hidden min-w-0 items-center gap-1.5 xl:ml-auto xl:inline-flex"
          title={`Session label at ${labelName}`}
        >
          <span className="text-muted-foreground/80">
            {labelName === "end of page" ? "At page end" : "At selection"}
          </span>
          <LaneGlyph label={label} />
          <span className={cn("font-medium", trustTone(label.trust).text)}>
            {trustTone(label.trust).label}
          </span>
          <span aria-hidden="true" className="text-muted-foreground/50">
            ·
          </span>
          <span className={cn("font-medium", audienceText(label.audience))}>
            {audienceTone(label.audience).label}
          </span>
        </span>
      ) : null}
      {changes.length > 0 ? (
        <Stepper
          changes={changes}
          active={activeChange}
          onActivate={onActivateChange}
        />
      ) : null}
    </>
  );
}

/**
 * The row's label rail: 3px trust lane and 3px audience lane, inset 3px so a
 * change marker can centre on them and the selection's edge shows beside
 * them, with a 16px hover/tap target for its tooltip.
 */
export function LabelRail({
  label,
  nodes,
  isChangeActive,
  onActivateChange,
  onSelectRow,
}: GutterProps & { onSelectRow: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {/* Inset 3px so a marker can centre on the lanes without the list's
          scroll box clipping it, and the selection edge shows in the gap:
          3px trust lane, 1px gap, 3px audience lane. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-[3px] z-[1] w-[7px] bg-card"
      >
        <span
          className={cn(
            "absolute inset-y-0 left-0 w-[3px]",
            trustLane(label.trust),
          )}
        />
        <span
          className={cn(
            "absolute inset-y-0 left-[4px] w-[3px]",
            audienceLane(label.audience),
          )}
        />
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
        <TooltipContent side="right" className="max-w-xs text-left">
          <p className="mb-1 font-medium">Session label at this row</p>
          <LaneLine
            glyph={<LaneGlyph highlight="trust" label={label} />}
            name="Trust"
            value={trustTone(label.trust).label}
          />
          <LaneLine
            glyph={<LaneGlyph highlight="audience" label={label} />}
            name="Audience"
            value={audienceTone(label.audience).label}
          />
          <p className="mt-1 opacity-70">
            Left lane is trust. Right lane is audience.
          </p>
        </TooltipContent>
      </Tooltip>
      {nodes && nodes.top.length > 0 ? (
        <Marker
          at="top"
          changes={nodes.top}
          active={nodes.top.some(isChangeActive)}
          onActivate={onActivateChange}
        />
      ) : null}
      {nodes && nodes.bottom.length > 0 ? (
        <Marker
          at="bottom"
          changes={nodes.bottom}
          active={nodes.bottom.some(isChangeActive)}
          onActivate={onActivateChange}
        />
      ) : null}
    </>
  );
}

/** "· [shield] Suspicious [lock] Internal": the marker's icons and new values, never cut. */
export function LabelChangeNote({ changes }: { changes: LabelChange[] }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap"
      title={changes.map(changeSentence).join(" ")}
    >
      <span aria-hidden="true" className="text-muted-foreground/40">
        ·
      </span>
      {changes.map((change) => {
        const { trust, audience } = change.segment;
        if (change.cause.kind === "reset") {
          return (
            <span
              key={change.key}
              className="inline-flex items-center gap-0.5 font-medium text-foreground/80"
            >
              <RotateCcw className="size-3 opacity-70" aria-hidden="true" />
              Reset
            </span>
          );
        }
        const TrustIcon = trustIcon(trust);
        const AudienceIcon = audience === "public" ? LockOpen : Lock;
        return (
          <span key={change.key} className="inline-flex items-center gap-1.5">
            {movedTrust(change) ? (
              <span
                className={cn(
                  "inline-flex items-center gap-0.5 font-medium",
                  trustTone(trust).text,
                )}
              >
                <TrustIcon
                  className="size-3 shrink-0"
                  strokeWidth={2.25}
                  aria-hidden="true"
                />
                {trustTone(trust).label}
              </span>
            ) : null}
            {movedAudience(change) ? (
              <span
                className={cn(
                  "inline-flex items-center gap-0.5 font-medium",
                  audienceText(audience),
                )}
              >
                <AudienceIcon
                  className="size-3 shrink-0"
                  strokeWidth={2.25}
                  aria-hidden="true"
                />
                {audienceTone(audience).label}
              </span>
            ) : null}
          </span>
        );
      })}
    </span>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

function KeyValue({ swatch, text }: { swatch: string; text: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-foreground/80">
      <span
        aria-hidden="true"
        className={cn(
          "h-3 w-[3px] shrink-0 rounded-[1px] ring-1 ring-foreground/10 ring-inset",
          swatch,
        )}
      />
      {text}
    </span>
  );
}

/** "‹ 2/3 label changes ›": steps through the changes, selecting each cause. */
function Stepper({
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
  const count = `${changes.length} label ${changes.length === 1 ? "change" : "changes"}`;
  // The shown change's own icon, as its marker draws it: a lock when only
  // the audience moved.
  const shown = changes[Math.max(0, active)];
  const StepperIcon =
    movedTrust(shown) || !movedAudience(shown)
      ? trustIcon(shown.segment.trust)
      : shown.segment.audience === "public"
        ? LockOpen
        : Lock;
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
            aria-label={`${count}.${active >= 0 ? ` Showing change ${active + 1}: ${changeSentence(changes[active])}` : ""} ${activateWords(shown)}`}
            className="inline-flex cursor-pointer items-center gap-1 border-x px-1.5 font-medium whitespace-nowrap tabular-nums outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
          >
            <StepperIcon
              aria-hidden="true"
              className={cn(
                "size-3 shrink-0",
                active >= 0 ? "text-primary" : "text-foreground/50",
              )}
              strokeWidth={2.25}
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
        <TooltipContent
          side="bottom"
          align="end"
          className="max-w-xs text-left"
        >
          <ol className="space-y-1">
            {changes.map((change, index) => (
              <li
                key={change.key}
                className={cn(index === active ? "font-medium" : "opacity-80")}
              >
                {index + 1}. {changeSentence(change)}{" "}
                <span className="font-normal opacity-70">
                  {causeSentence(change)}
                </span>
              </li>
            ))}
          </ol>
          <p className="mt-1 opacity-70">
            The arrows step through them and show what caused each one.
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

function LaneLine({
  glyph,
  name,
  value,
}: {
  glyph: ReactNode;
  name: string;
  value: string;
}) {
  return (
    <p className="flex items-center gap-1.5">
      {glyph}
      <span className="opacity-70">{name}</span>
      <span className="font-medium">{value}</span>
    </p>
  );
}

/**
 * A change on the rail's edge: a round marker centred on the lanes, a shield
 * in the new trust colour when trust moved, a lock in the audience colour
 * when the audience moved, stacked in one capsule when both did.
 */
function Marker({
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
  const { trust, audience } = last.segment;
  const trustMoved = changes.some(movedTrust);
  const audienceMoved = changes.some(movedAudience);
  const both = trustMoved && audienceMoved;
  const TrustIcon = trustIcon(trust);
  const AudienceIcon = audience === "public" ? LockOpen : Lock;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          tabIndex={-1}
          onClick={() => onActivate(last)}
          aria-label={`${changes.map(changeSentence).join(" ")} ${activateWords(last)}`}
          className={cn(
            "group/marker absolute left-0 z-[4] flex w-[13px] cursor-pointer justify-center outline-none",
            at === "top"
              ? "top-0 -translate-y-1/2"
              : "bottom-0 translate-y-1/2",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "flex w-[15px] flex-col items-center justify-center rounded-full border bg-card ring-2 ring-card transition-transform group-hover/marker:scale-110",
              both ? "h-[26px] gap-px" : "h-[15px]",
              trustMoved ? trustMark(trust) : audienceMark(audience),
              active && "outline-2 outline-offset-1 outline-primary",
            )}
          >
            {trustMoved || !audienceMoved ? (
              <TrustIcon className="size-2.5 shrink-0" strokeWidth={2.5} />
            ) : null}
            {audienceMoved ? (
              <AudienceIcon
                className={cn(
                  "size-2.5 shrink-0",
                  both && audienceIconTone(audience),
                )}
                strokeWidth={2.5}
              />
            ) : null}
          </span>
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-xs text-left">
        <div className="space-y-1">
          {changes.map((change) => (
            <div key={change.key}>
              <p className="font-medium">{changeSentence(change)}</p>
              <p className="opacity-80">{causeSentence(change)}</p>
            </div>
          ))}
        </div>
        <p className="mt-1 opacity-70">
          {last.target.type === "request"
            ? "Click to open the request that caused it."
            : "Click to select the row that caused it."}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A tiny two-lane rail. With `label`, lanes take its colours; `highlight`
 * keeps one lane coloured and dims the other, naming which lane is meant.
 */
function LaneGlyph({
  highlight,
  label,
  small = false,
}: {
  highlight?: "trust" | "audience";
  label?: LabelState;
  small?: boolean;
}) {
  const left = label ? trustStrong(label.trust) : "bg-foreground/60";
  const right = label ? audienceStrong(label.audience) : "bg-foreground/60";
  const lane = cn("rounded-[1px]", small ? "w-[2px]" : "w-[3px]");
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-stretch gap-px",
        small ? "h-2.5" : "h-3",
      )}
    >
      <span className={cn(lane, highlight === "audience" ? OFF_LANE : left)} />
      <span className={cn(lane, highlight === "trust" ? OFF_LANE : right)} />
    </span>
  );
}

function changeSentence(change: LabelChange): string {
  const { trust, audience } = change.segment;
  if (change.cause.kind === "reset") {
    return `The label was reset to ${trustTone(trust).label} and ${audienceTone(audience).label}.`;
  }
  const t = movedTrust(change);
  const a = movedAudience(change);
  if (t && a) {
    return `Trust changed to ${trustTone(trust).label} and audience to ${audienceTone(audience).label}.`;
  }
  if (t) return `Trust changed to ${trustTone(trust).label}.`;
  if (a) return `Audience changed to ${audienceTone(audience).label}.`;
  return "The label was set.";
}

/** What activating a change does, for its accessible name. */
function activateWords(change: LabelChange): string {
  return change.target.type === "request"
    ? "Opens the request that caused it."
    : "Selects the row that caused it.";
}

function causeSentence(change: LabelChange): string {
  const { event, toolName } = change.cause;
  switch (event) {
    case "tool_result":
      if (change.target.type === "request") {
        return `Caused by the result of ${toolName ?? "a tool"}, asked for on another page.`;
      }
      return toolName
        ? `Caused by the result of ${toolName}.`
        : "Caused by a tool result.";
    case "tool_call":
      return toolName
        ? `Caused by calling ${toolName}.`
        : "Caused by a tool call.";
    case "remedy":
      return "Caused by an approved remedy plan.";
    case "child_return":
      return "Caused by a sub-agent's result.";
    case "session_start":
      return "Set when the session started.";
    case "other":
      return "The policy changed the session's label.";
  }
}

function movedTrust(change: LabelChange): boolean {
  return (
    change.cause.kind === "reset" ||
    change.parts.some((part) => part.field === "Trust")
  );
}

function movedAudience(change: LabelChange): boolean {
  return (
    change.cause.kind === "reset" ||
    change.parts.some((part) => part.field === "Audience")
  );
}

/** The rail's trust lane: trusted is calm, suspicious is loud. */
function trustLane(trust: string): string {
  if (trust === "trusted") return "bg-emerald-500/55 dark:bg-emerald-400/50";
  if (trust === "suspicious") return "bg-rose-500 dark:bg-rose-400";
  return trustTone(trust).bar;
}

/** The rail's audience lane: public is the faint default. */
function audienceLane(audience: string): string {
  if (audience === "public") return "bg-foreground/[0.13]";
  return audienceTone(audience).bar;
}

/** Marker and glyph fills: the lane colours at full strength. */
function trustStrong(trust: string): string {
  return trustTone(trust).bar;
}

function audienceStrong(audience: string): string {
  if (audience === "public") return "bg-foreground/35";
  return audienceTone(audience).bar;
}

function audienceText(audience: string): string {
  if (audience === "public") return "text-foreground/80";
  return audienceTone(audience).text;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

const OFF_LANE = "bg-foreground/[0.12]";

function trustIcon(trust: string): typeof Shield {
  if (trust === "trusted") return ShieldCheck;
  if (trust === "suspicious") return ShieldAlert;
  return Shield;
}

function trustMark(trust: string): string {
  if (trust === "trusted")
    return "border-emerald-600/60 text-emerald-700 dark:border-emerald-400/60 dark:text-emerald-300";
  if (trust === "suspicious")
    return "border-rose-500/80 text-rose-600 dark:border-rose-400/80 dark:text-rose-300";
  return "border-foreground/35 text-foreground/80";
}

function audienceMark(audience: string): string {
  return cn("border-current", audienceIconTone(audience));
}

function audienceIconTone(audience: string): string {
  if (audience === "public") return "text-foreground/70";
  return audienceTone(audience).text;
}
