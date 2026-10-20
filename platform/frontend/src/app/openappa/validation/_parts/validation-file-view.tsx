"use client";

import type { Monaco, OnMount } from "@monaco-editor/react";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Download,
  History,
  Loader2,
  LockKeyhole,
  MoreHorizontal,
  Pencil,
  Play,
  Save,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import type { PolicyTestRun } from "@/lib/openappa-policy-tests.query";
import { formatDate } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import {
  OpenAppaPageAction,
  OpenAppaPageHeader,
} from "../../_parts/openappa-page-action";
import { statusLabel } from "./validation-parts";

// ===========================================================================
// File page that speaks the runner's language: a quiet header, then the
// editor with a terminal pane docked under it. The pane prints this file's
// last result exactly like the Run-all drawer prints a suite.
// ===========================================================================

/** Props the validation file page hands its view. */
export type ValidationFileViewProps = {
  /** Path as currently typed (form value). */
  filename: string;
  /** Rename the file (marks the form dirty; Save persists it). Undefined when read-only. */
  onRename?: (next: string) => void;
  /** Human name from the first comment line. */
  name: string;
  status: "passed" | "failed" | "cannot_run" | "not_run";
  lastRun: { at: string; label: string; href: string } | null;
  dirty: boolean;
  github: boolean;
  canWrite: boolean;
  run: {
    label: string;
    running: boolean;
    disabled: boolean;
    onClick: () => void;
  };
  save?: { disabled: boolean; onClick: () => void };
  /** Download the file as currently edited. */
  onExport: () => void;
  onDelete?: () => void;
  /** The engine's raw failure explanation. */
  failure: string | null;
  /** Latest result for this file (steps up to the first failure). */
  result: PolicyTestFileResult | undefined;
  /** The editor card, already wired to the form. */
  editor: ReactNode;
  /** Live Monaco handles once the editor mounted. */
  getEditor: () => {
    editor: Parameters<OnMount>[0];
    monaco: Monaco;
  } | null;
  /** Scroll the editor to a line, put the cursor there and focus it. */
  revealLine: (line: number) => void;
  /** This file's recorded results across past runs, newest first. */
  fileRuns: {
    runId: string;
    createdAt: string;
    status: "passed" | "failed" | "cannot_run";
    policyRevision: number;
    trigger: PolicyTestRun["trigger"];
    partial: boolean;
  }[];
};

export function ValidationFileView(props: ValidationFileViewProps) {
  const [renameOpen, setRenameOpen] = useState(false);
  const contentHeight = useEditorMarks(props);
  // Fit the editor to its text (validations are short) so the output pane
  // sits in view; long files scroll inside the editor.
  const editorHeight =
    contentHeight === null
      ? null
      : `clamp(14rem, ${Math.ceil(contentHeight) + 2}px, 52vh)`;
  return (
    <div className="space-y-4">
      <style>{EDITOR_MARK_CSS}</style>
      {editorHeight && (
        <style>{`.appa-r27-editor [data-slot=card] section { height: ${editorHeight} !important; transition: height 200ms ease; }`}</style>
      )}
      <Header {...props} onRenameClick={() => setRenameOpen(true)} />
      <div
        className={cn(
          "appa-r27-editor overflow-hidden rounded-xl border bg-card shadow-xs",
          // The editor arrives as its own card: flatten it into this surface.
          "[&_[data-slot=card]]:rounded-none [&_[data-slot=card]]:border-0 [&_[data-slot=card]]:shadow-none",
        )}
      >
        {props.editor}
        <TerminalPane {...props} />
      </div>
      {props.onRename && (
        <RenameDialog
          open={renameOpen}
          onOpenChange={setRenameOpen}
          filename={props.filename}
          onRename={props.onRename}
        />
      )}
    </div>
  );
}

// ===========================================================================
// Header
// ===========================================================================

function Header({
  filename,
  name,
  status,
  dirty,
  github,
  run,
  save,
  onExport,
  onDelete,
  onRename,
  onRenameClick,
  lastRun,
}: ValidationFileViewProps & { onRenameClick: () => void }) {
  const base = filename.slice(filename.lastIndexOf("/") + 1);
  const title = name && name !== base ? name : base;
  // The path is not repeated here: the title names the file, and renaming
  // lives in the "…" menu.
  const notes = (github || dirty) && (
    <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
      {github && (
        <span className="inline-flex shrink-0 items-center gap-1 text-xs">
          <LockKeyhole className="size-3" />
          <span>GitHub</span>
        </span>
      )}
      {dirty && (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-foreground/80 animate-in fade-in duration-200">
          <span className="size-1.5 rounded-full bg-primary" />
          <span>Unsaved</span>
        </span>
      )}
    </span>
  );
  return (
    <>
      <OpenAppaPageHeader
        title={title}
        status={
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[11px] font-medium leading-none",
              STATUS_TEXT[status],
              STATUS_TINT[status],
            )}
          >
            {statusLabel(status)}
          </span>
        }
        description={notes || undefined}
      />
      <OpenAppaPageAction>
        <div className="flex shrink-0 items-center gap-2">
          {save && dirty && (
            <Button
              size="sm"
              variant="outline"
              disabled={save.disabled}
              onClick={save.onClick}
            >
              <Save />
              <span>Save</span>
            </Button>
          )}
          <Button size="sm" disabled={run.disabled} onClick={run.onClick}>
            {run.running ? <Loader2 className="animate-spin" /> : <Play />}
            <span>{run.label}</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-sm"
                variant="outline"
                aria-label="More file actions"
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {onRename && (
                <DropdownMenuItem onSelect={onRenameClick}>
                  <Pencil />
                  <span>Rename…</span>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={onExport}>
                <Download />
                <span>Export</span>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={lastRun?.href ?? HISTORY_HREF}>
                  <History />
                  <span>Run history</span>
                </Link>
              </DropdownMenuItem>
              {onDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                    <Trash2 />
                    <span>Delete</span>
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </OpenAppaPageAction>
    </>
  );
}

// ===========================================================================
// Terminal pane
// ===========================================================================

type Tab = "output" | "history";

function TerminalPane(props: ValidationFileViewProps) {
  const { run, result, fileRuns, filename } = props;
  const [tab, setTab] = useState<Tab>("output");
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState(() => performance.now());
  const [duration, setDuration] = useState<number | null>(null);
  const startedAt = useRef<number | null>(
    run.running ? performance.now() : null,
  );
  const wasRunning = useRef(run.running);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Running → finished: remember how long it took, then stream the new result in.
  const [streamKey, setStreamKey] = useState(0);
  useEffect(() => {
    if (run.running && !wasRunning.current) {
      startedAt.current = performance.now();
      setNow(performance.now());
      setTab("output");
      setCollapsed(false);
    }
    if (!run.running && wasRunning.current) {
      if (startedAt.current !== null)
        setDuration(performance.now() - startedAt.current);
      setStreamKey((k) => k + 1);
    }
    wasRunning.current = run.running;
  }, [run.running]);

  useEffect(() => {
    if (!run.running) return;
    const id = setInterval(() => setNow(performance.now()), 80);
    return () => clearInterval(id);
  }, [run.running]);

  const elapsed = startedAt.current === null ? 0 : now - startedAt.current;
  const rows = useMemo(
    () =>
      outputRows({
        props,
        duration,
      }),
    [props, duration],
  );
  const revealed = useStream(rows.length, streamKey, !run.running);

  // Follow the stream like a terminal.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when output grows
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [revealed, run.running]);

  const steps = result?.steps ?? [];
  const passed = steps.filter((s) => s.status === "passed").length;
  const failed = steps.length - passed;
  const outcome: Outcome = run.running
    ? "run"
    : props.status === "passed"
      ? "pass"
      : props.status === "failed"
        ? "fail"
        : props.status === "cannot_run"
          ? "warn"
          : "idle";

  return (
    <section
      aria-label="Run output"
      className="border-t border-black/40 bg-[#0b0c0f] text-zinc-300 dark:border-white/[0.06]"
    >
      {/* Pane header */}
      <div className="relative flex h-10 items-center gap-1 border-b border-white/[0.07] bg-white/[0.025] pr-2 pl-1.5 sm:pl-2.5">
        <PaneTab
          active={tab === "output"}
          onClick={() => {
            setTab("output");
            setCollapsed(false);
          }}
        >
          <span>Output</span>
        </PaneTab>
        <PaneTab
          active={tab === "history"}
          onClick={() => {
            setTab("history");
            setCollapsed(false);
          }}
        >
          <span>History</span>
          {fileRuns.length > 0 && (
            <span className="tabular-nums text-zinc-600">
              {fileRuns.length}
            </span>
          )}
        </PaneTab>

        <div className="ml-auto flex min-w-0 items-center gap-3 font-mono text-[11.5px] tabular-nums">
          {run.running ? (
            <span className="flex items-center gap-2 text-sky-300 animate-in fade-in duration-200">
              <span>{SPINNER[Math.floor(elapsed / 80) % SPINNER.length]}</span>
              <span>{formatSeconds(elapsed)}</span>
            </span>
          ) : result ? (
            <span className="hidden items-center gap-2.5 sm:flex">
              <CountDot tone="pass" value={passed} />
              <CountDot tone="fail" value={failed} />
              <span className="text-zinc-600">{`of ${result.assertionCount}`}</span>
            </span>
          ) : null}
          <Tag tone={outcome}>{outcomeLabel[outcome]}</Tag>
        </div>
        <Button
          size="icon-xs"
          variant="ghost"
          className={terminalGhost}
          aria-label={collapsed ? "Expand output" : "Collapse output"}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? <ChevronUp /> : <ChevronDown />}
        </Button>
        {run.running && (
          <span
            aria-hidden
            className="absolute inset-x-0 bottom-0 h-px overflow-hidden"
          >
            <span
              className="block h-full w-1/3 bg-gradient-to-r from-transparent via-sky-400/80 to-transparent"
              style={{
                animation:
                  "appa-r27-sweep 1.1s cubic-bezier(0.4,0,0.2,1) infinite",
              }}
            />
          </span>
        )}
      </div>

      {/* Body: collapses with a grid-rows transition */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
          collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div
            ref={scrollRef}
            aria-live="polite"
            className={cn(
              "max-h-[24rem] min-h-[11rem] overflow-y-auto overscroll-contain px-3 py-3 font-mono text-[12.5px] leading-[1.7] sm:px-5 sm:py-4",
              "[scrollbar-color:rgba(255,255,255,0.15)_transparent]",
            )}
          >
            {tab === "history" ? (
              <HistoryLines {...props} />
            ) : run.running ? (
              <RunningLines
                key="running"
                filename={filename}
                assertionCount={result?.assertionCount ?? null}
                elapsed={elapsed}
              />
            ) : (
              <div key={`out-${streamKey}`}>
                {rows.slice(0, revealed).map((row) => (
                  <div
                    key={row.key}
                    className="animate-in fade-in slide-in-from-left-1 duration-200"
                  >
                    {row.node}
                  </div>
                ))}
                {revealed < rows.length && <Cursor />}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function PaneTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <UnstyledButton
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "relative flex h-full items-center gap-1.5 px-2 font-mono text-[11.5px] uppercase tracking-wider outline-none transition-colors focus-visible:text-zinc-100",
        active ? "text-zinc-100" : "text-zinc-500 hover:text-zinc-300",
      )}
    >
      {children}
      <span
        aria-hidden
        className={cn(
          "absolute inset-x-2 bottom-0 h-px bg-zinc-200 transition-opacity",
          active ? "opacity-100" : "opacity-0",
        )}
      />
    </UnstyledButton>
  );
}

// ===========================================================================
// Output rows (finished state)
// ===========================================================================

type Row = { key: string; node: ReactNode };

function outputRows({
  props,
  duration,
}: {
  props: ValidationFileViewProps;
  duration: number | null;
}): Row[] {
  const { result, filename, fileRuns, lastRun, failure, revealLine } = props;
  const rows: Row[] = [];
  const latest = fileRuns[0];

  if (!result) {
    rows.push({
      key: "prompt",
      node: (
        <Line>
          <Glyph className="text-zinc-600">$</Glyph>
          <span className="min-w-0 break-all text-zinc-400">{`appa test ${filename}`}</span>
        </Line>
      ),
    });
    rows.push({
      key: "empty",
      node: (
        <Line className="mt-1 text-zinc-500">
          <Glyph />
          <span className="min-w-0 break-words">
            {`No result yet. ${props.run.label} replays it in a fresh session against the current policy.`}
          </span>
        </Line>
      ),
    });
    return rows;
  }

  const outcome: Outcome =
    result.status === "passed"
      ? "pass"
      : result.status === "failed"
        ? "fail"
        : "warn";
  rows.push({
    key: "head",
    node: (
      <Line className="mb-2">
        <Tag tone={outcome}>{outcomeLabel[outcome]}</Tag>
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5">
          <PathText path={filename} className="text-zinc-100" />
          <span className="text-zinc-500">
            {plural(result.assertionCount, "assertion")}
          </span>
          {duration !== null && (
            <span className="text-zinc-500 tabular-nums">
              {formatSeconds(duration)}
            </span>
          )}
        </span>
      </Line>
    ),
  });

  const firstBad = result.steps.find((s) => s.status !== "passed");
  for (const step of result.steps) {
    rows.push({
      key: `step:${step.line}:${step.tool}`,
      node: <StepLine step={step} onReveal={revealLine} />,
    });
  }
  const notReached = Math.max(0, result.assertionCount - result.steps.length);
  if (notReached > 0) {
    rows.push({
      key: "not-reached",
      node: (
        <Line className="text-zinc-600">
          <Glyph>○</Glyph>
          <span className="w-8 shrink-0" />
          <span>{`${plural(notReached, "assertion")} not reached`}</span>
        </Line>
      ),
    });
  }

  // The failure report, Jest style.
  const raw =
    firstBad?.error ??
    failure ??
    (result.status !== "passed" ? result.error : null) ??
    null;
  if (result.status !== "passed") {
    rows.push({ key: "gap-1", node: <div className="h-4" /> });
    rows.push({
      key: "bullet",
      node: (
        <Line
          className={
            result.status === "failed" ? "text-red-400" : "text-yellow-300"
          }
        >
          <Glyph>●</Glyph>
          <span className="min-w-0 break-all font-semibold">
            {firstBad
              ? `${firstBad.tool} › line ${firstBad.line}`
              : "Validation could not run"}
          </span>
        </Line>
      ),
    });
    if (firstBad?.status === "failed") {
      rows.push({ key: "gap-2", node: <div className="h-2" /> });
      rows.push({
        key: "expected",
        node: (
          <Indent>
            <span className="text-green-400">{"- Expected  "}</span>
            <span className="text-green-300">{firstBad.expected}</span>
          </Indent>
        ),
      });
      rows.push({
        key: "received",
        node: (
          <Indent>
            <span className="text-red-400">{"+ Received  "}</span>
            <span className="text-red-300">
              {firstBad.actual ?? "no decision"}
            </span>
          </Indent>
        ),
      });
    }
    const why = withStepReasons(raw ? digest(raw) : null, firstBad?.reasons);
    if (why) {
      rows.push({ key: "gap-3", node: <div className="h-2" /> });
      if (why.reasons.length > 0) {
        rows.push({
          key: "why-label",
          node: (
            <Indent className="text-zinc-500">
              <span>Why</span>
            </Indent>
          ),
        });
        for (const reason of why.reasons) {
          rows.push({
            key: `why:${reason}`,
            node: (
              <Indent className="flex gap-2 text-zinc-100">
                <span className="text-red-400/80">›</span>
                <span className="min-w-0 break-words">{reason}</span>
              </Indent>
            ),
          });
        }
      } else {
        rows.push({
          key: "headline",
          node: (
            <Indent className="break-words text-zinc-200">
              <span>{why.headline}</span>
            </Indent>
          ),
        });
      }
      if (why.rest) {
        rows.push({
          key: "engine",
          node: (
            <Indent>
              <details className="group mt-1">
                <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-zinc-600 outline-none hover:text-zinc-400 focus-visible:text-zinc-300 [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
                  <span>Engine output for agents</span>
                </summary>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/40 p-2.5 text-[11.5px] text-zinc-500">
                  {[why.headline, why.rest].filter(Boolean).join("\n\n")}
                </pre>
              </details>
            </Indent>
          ),
        });
      }
    }
    if (firstBad) {
      rows.push({ key: "gap-4", node: <div className="h-2" /> });
      rows.push({
        key: "jump",
        node: (
          <Indent>
            <UnstyledButton
              onClick={() => revealLine(firstBad.line)}
              className="group flex max-w-full items-baseline gap-1.5 text-left text-sky-300/90 outline-none hover:text-sky-200 focus-visible:underline"
            >
              <span className="text-zinc-600">❯</span>
              <span className="break-all underline-offset-4 group-hover:underline">
                {`${filename}:${firstBad.line}`}
              </span>
            </UnstyledButton>
          </Indent>
        ),
      });
    }
  }

  // Summary block.
  const passed = result.steps.filter((s) => s.status === "passed").length;
  const failed = result.steps.length - passed;
  const runFacts = [
    latest ? `policy rev ${latest.policyRevision}` : null,
    latest
      ? triggerLabel(latest.trigger, latest.partial)
      : lastRun?.label?.toLowerCase(),
  ].filter(Boolean);
  rows.push({
    key: "summary",
    node: (
      <div className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 border-t border-white/[0.06] pt-3">
        <SummaryLabel>Assertions</SummaryLabel>
        <span className="min-w-0 break-words">
          <span
            className={
              passed > 0 ? "font-semibold text-green-400" : "text-zinc-500"
            }
          >{`${passed} passed`}</span>
          {failed > 0 && (
            <>
              <span className="text-zinc-600">{" | "}</span>
              <span className="font-semibold text-red-400">{`${failed} failed`}</span>
            </>
          )}
          {notReached > 0 && (
            <>
              <span className="text-zinc-600">{" | "}</span>
              <span className="text-zinc-400">{`${notReached} not reached`}</span>
            </>
          )}
          <span className="text-zinc-500">{` (${result.assertionCount})`}</span>
        </span>
        {lastRun && (
          <>
            <SummaryLabel>Ran at</SummaryLabel>
            <span className="min-w-0 break-words">
              <span className="text-zinc-300">
                {formatDate({
                  date: lastRun.at,
                  dateFormat: "MMM d, HH:mm:ss",
                })}
              </span>
              {runFacts.length > 0 && (
                <span className="text-zinc-500">{`  ${runFacts.join(" · ")}`}</span>
              )}
            </span>
          </>
        )}
        {duration !== null && (
          <>
            <SummaryLabel>Duration</SummaryLabel>
            <span className="text-zinc-100 tabular-nums">
              {formatSeconds(duration)}
            </span>
          </>
        )}
        {props.dirty && (
          <>
            <SummaryLabel>Source</SummaryLabel>
            <span className="text-yellow-300/80">
              unsaved edits since this result
            </span>
          </>
        )}
      </div>
    ),
  });
  return rows;
}

function StepLine({
  step,
  onReveal,
}: {
  step: PolicyTestStep;
  onReveal: (line: number) => void;
}) {
  const ok = step.status === "passed";
  return (
    <UnstyledButton
      onClick={() => onReveal(step.line)}
      title={`Go to line ${step.line}`}
      className="-mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-baseline gap-2 rounded px-1.5 text-left outline-none hover:bg-white/[0.04] focus-visible:bg-white/[0.06]"
    >
      <Glyph
        className={
          ok
            ? "text-green-400"
            : step.status === "failed"
              ? "text-red-400"
              : "text-yellow-300"
        }
      >
        {ok ? "✓" : step.status === "failed" ? "✗" : "○"}
      </Glyph>
      <span className="w-8 shrink-0 tabular-nums text-zinc-600">{`L${step.line}`}</span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          ok ? "text-zinc-300" : "text-zinc-100",
        )}
      >
        {step.tool}
      </span>
      <span className="hidden shrink-0 sm:inline">
        {ok ? (
          <span className="text-zinc-500">{step.expected}</span>
        ) : (
          <span>
            <span className="text-zinc-500">{`${step.expected} → `}</span>
            <span className="text-red-400">{step.actual ?? "no decision"}</span>
          </span>
        )}
      </span>
    </UnstyledButton>
  );
}

// ===========================================================================
// Running + history
// ===========================================================================

function RunningLines({
  filename,
  assertionCount,
  elapsed,
}: {
  filename: string;
  assertionCount: number | null;
  elapsed: number;
}) {
  return (
    <div className="animate-in fade-in duration-200">
      <Line className="mb-2">
        <Tag tone="run">RUN</Tag>
        <PathText path={filename} className="min-w-0 text-zinc-100" />
      </Line>
      <Line className="text-zinc-500">
        <Glyph className="text-zinc-600">·</Glyph>
        <span>fresh session · current policy</span>
      </Line>
      {elapsed > 350 && (
        <Line className="animate-in fade-in slide-in-from-left-1 duration-200">
          <Glyph className="text-sky-300">
            {SPINNER[Math.floor(elapsed / 80) % SPINNER.length]}
          </Glyph>
          <span className="min-w-0 flex-1 text-zinc-300">
            {assertionCount
              ? `replaying ${plural(assertionCount, "assertion")}…`
              : "replaying tool calls…"}
          </span>
          <span className="shrink-0 tabular-nums text-zinc-500">
            {formatSeconds(elapsed)}
          </span>
        </Line>
      )}
      {elapsed > 2500 && (
        <Line className="animate-in fade-in duration-500 italic text-zinc-500">
          <Glyph>
            <span className="relative inline-flex size-1.5 translate-y-[-1px]">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-violet-400/60" />
              <span className="relative inline-flex size-1.5 rounded-full bg-violet-400" />
            </span>
          </Glyph>
          <span>waiting on the annotator model…</span>
        </Line>
      )}
      <Cursor />
    </div>
  );
}

function HistoryLines({ fileRuns, lastRun }: ValidationFileViewProps) {
  if (fileRuns.length === 0)
    return (
      <Line className="text-zinc-500 animate-in fade-in duration-200">
        <Glyph className="text-zinc-600">$</Glyph>
        <span>No recorded runs for this file yet.</span>
      </Line>
    );
  const passed = fileRuns.filter((r) => r.status === "passed").length;
  return (
    <div className="animate-in fade-in duration-200">
      <Line className="mb-2 text-zinc-500">
        <Glyph className="text-zinc-600">$</Glyph>
        <span className="min-w-0 flex-1">{`${plural(fileRuns.length, "run")} · ${passed} passed`}</span>
        <span aria-hidden className="hidden items-center gap-[3px] sm:flex">
          {[...fileRuns]
            .slice(0, 24)
            .reverse()
            .map((r) => (
              <span
                key={r.runId}
                className={cn("h-2.5 w-1 rounded-[1px]", statusBar[r.status])}
              />
            ))}
        </span>
      </Line>
      {fileRuns.map((r, i) => (
        <div
          key={r.runId}
          className="animate-in fade-in slide-in-from-left-1 fill-mode-both duration-200"
          style={{ animationDelay: `${Math.min(i, 12) * 25}ms` }}
        >
          <Line>
            <Glyph className={statusText[r.status]}>
              {statusGlyph[r.status]}
            </Glyph>
            <span className="w-[6.5rem] shrink-0 tabular-nums text-zinc-300 sm:w-[7.5rem]">
              {formatDate({ date: r.createdAt, dateFormat: "MMM d HH:mm" })}
            </span>
            <span className="hidden w-14 shrink-0 tabular-nums text-zinc-500 sm:inline">{`rev ${r.policyRevision}`}</span>
            <span className="min-w-0 flex-1 truncate text-zinc-500">
              {triggerLabel(r.trigger, r.partial)}
            </span>
            {i === 0 && <span className="shrink-0 text-zinc-600">latest</span>}
          </Line>
        </div>
      ))}
      <Link
        href={lastRun?.href ?? HISTORY_HREF}
        className="group mt-3 inline-flex items-baseline gap-1.5 text-sky-300/90 outline-none hover:text-sky-200 focus-visible:underline"
      >
        <span className="text-zinc-600">❯</span>
        <span className="underline-offset-4 group-hover:underline">
          open run history
        </span>
      </Link>
    </div>
  );
}

// ===========================================================================
// Editor marks: ✓/✗ beside each asserted tool call, the failure inline
// ===========================================================================

function useEditorMarks({ getEditor, result }: ValidationFileViewProps) {
  const getEditorRef = useRef(getEditor);
  getEditorRef.current = getEditor;
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  useEffect(() => {
    let collection: { clear: () => void } | null = null;
    let sizeListener: { dispose: () => void } | null = null;
    let tries = 0;
    const apply = () => {
      const handle = getEditorRef.current();
      if (!handle) return false;
      const { editor, monaco } = handle;
      const model = editor.getModel();
      if (!model) return false;
      setContentHeight(editor.getContentHeight());
      sizeListener = editor.onDidContentSizeChange((event) =>
        setContentHeight(event.contentHeight),
      );
      const lineCount = model.getLineCount();
      const decorations = (result?.steps ?? [])
        .filter((step) => step.line >= 1 && step.line <= lineCount)
        .flatMap((step) => {
          const ok = step.status === "passed";
          const end = model.getLineMaxColumn(step.line);
          return [
            {
              range: new monaco.Range(step.line, 1, step.line, 1),
              options: {
                isWholeLine: true,
                className: ok ? undefined : "appa-r27-fail-line",
                linesDecorationsClassName: ok
                  ? "appa-r27-bar-pass"
                  : "appa-r27-bar-fail",
              },
            },
            {
              range: new monaco.Range(step.line, end, step.line, end),
              options: {
                after: {
                  content: ok
                    ? `    \u2713 ${step.expected}`
                    : `    \u2717 expected ${step.expected}, received ${step.actual ?? "no decision"}`,
                  inlineClassName: ok
                    ? "appa-r27-after-pass"
                    : "appa-r27-after-fail",
                },
              },
            },
          ];
        });
      collection = editor.createDecorationsCollection(decorations);
      return true;
    };
    let id: ReturnType<typeof setInterval> | null = null;
    if (!apply()) {
      id = setInterval(() => {
        tries += 1;
        if (apply() || tries > 40) {
          if (id) clearInterval(id);
        }
      }, 150);
    }
    return () => {
      if (id) clearInterval(id);
      collection?.clear();
      sizeListener?.dispose();
    };
  }, [result]);
  return contentHeight;
}

const EDITOR_MARK_CSS = `
.appa-r27-bar-pass { background: rgb(34 197 94 / 0.7); width: 2px !important; margin-left: 4px; }
.appa-r27-bar-fail { background: rgb(239 68 68); width: 2px !important; margin-left: 4px; }
.appa-r27-fail-line { background: rgb(239 68 68 / 0.08); }
.appa-r27-after-pass { color: rgb(34 197 94 / 0.55); font-style: normal; }
.appa-r27-after-fail { color: rgb(248 113 113 / 0.85); font-style: normal; }
@keyframes appa-r27-sweep { from { transform: translateX(-100%); } to { transform: translateX(300%); } }
`;

// ===========================================================================
// Terminal primitives
// ===========================================================================

function Line({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 items-baseline gap-2", className)}>
      {children}
    </div>
  );
}

function Indent({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("ml-[1.35rem] min-w-0 break-words", className)}>
      {children}
    </div>
  );
}

function Glyph({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("w-3.5 shrink-0 text-center", className)}>
      {children}
    </span>
  );
}

function Cursor() {
  return (
    <span
      aria-hidden
      className="ml-[1.35rem] inline-block h-[1.05em] w-[0.55em] translate-y-[0.2em] animate-pulse bg-zinc-400/80"
    />
  );
}

function SummaryLabel({ children }: { children: ReactNode }) {
  return <span className="text-right text-zinc-500">{children}</span>;
}

function PathText({ path, className }: { path: string; className?: string }) {
  const slash = path.lastIndexOf("/");
  return (
    <span className={cn("min-w-0 break-all", className)}>
      <span className="text-zinc-500">{path.slice(0, slash + 1)}</span>
      <span>{path.slice(slash + 1)}</span>
    </span>
  );
}

/** Vitest's inverse-video status chip. */
function Tag({ tone, children }: { tone: Outcome; children: ReactNode }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-[3px] px-1.5 font-mono text-[11px] font-bold leading-[1.6] tracking-wide",
        tone === "run" && "bg-sky-400 text-sky-950",
        tone === "pass" && "bg-green-500 text-green-950",
        tone === "fail" && "bg-red-500 text-white",
        tone === "warn" && "bg-yellow-400 text-yellow-950",
        tone === "idle" && "bg-zinc-700 text-zinc-100",
      )}
    >
      {children}
    </span>
  );
}

function CountDot({ tone, value }: { tone: "pass" | "fail"; value: number }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className={cn(
          "size-1.5 rounded-full",
          tone === "pass" ? "bg-green-400" : "bg-red-400",
        )}
      />
      <span
        className={
          value > 0
            ? tone === "pass"
              ? "text-green-400"
              : "text-red-400"
            : "text-zinc-600"
        }
      >
        {value}
      </span>
    </span>
  );
}

// ===========================================================================
// Rename
// ===========================================================================

function RenameDialog({
  open,
  onOpenChange,
  filename,
  onRename,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filename: string;
  onRename: (next: string) => void;
}) {
  // Only the name is editable: the folder is where the suite reads
  // validations from, so moving a file out of it would drop it.
  const slash = filename.lastIndexOf("/");
  const dir = filename.slice(0, slash + 1);
  const stem = filename.slice(slash + 1).replace(/\.appa$/, "");
  const [value, setValue] = useState(stem);
  useEffect(() => {
    if (open) setValue(stem);
  }, [open, stem]);
  const trimmed = value.trim().replace(/\.appa$/, "");
  const valid = /^[a-zA-Z0-9_.-]+$/.test(trimmed) && !/^\.+$/.test(trimmed);
  const submit = (_e: FormEvent<HTMLFormElement>) => {
    if (!valid) return;
    const next = `${dir}${trimmed}.appa`;
    if (next !== filename) onRename(next);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogForm onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Rename file</DialogTitle>
            <DialogDescription>
              The new name takes effect when you save.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-2">
            <div className="flex items-center rounded-md border border-input bg-transparent shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30">
              <Input
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
                aria-label="File name"
                aria-invalid={!valid}
                className="min-w-0 flex-1 border-0 bg-transparent font-mono shadow-none focus-visible:ring-0 dark:bg-transparent"
                spellCheck={false}
              />
              <span className="shrink-0 pr-3 font-mono text-sm text-muted-foreground">
                .appa
              </span>
            </div>
            <p
              className={cn(
                "text-xs",
                valid ? "text-muted-foreground" : "text-destructive",
              )}
            >
              {valid ? (
                <span>
                  Stays in <span className="font-mono">{dir || "/"}</span>
                </span>
              ) : (
                <span>Use letters, digits, “.”, “_” and “-”.</span>
              )}
            </p>
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!valid}>
              Rename
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}

// ===========================================================================
// Helpers
// ===========================================================================

type Outcome = "run" | "pass" | "fail" | "warn" | "idle";
type FileRunStatus = ValidationFileViewProps["fileRuns"][number]["status"];

/** Reveal `total` rows one by one whenever `key` changes (and on mount). */
function useStream(total: number, key: number, enabled: boolean) {
  const [revealed, setRevealed] = useState(0);
  const reduceMotion = usePrefersReducedMotion();
  // biome-ignore lint/correctness/useExhaustiveDependencies: restart on key
  useEffect(() => {
    setRevealed(0);
  }, [key]);
  useEffect(() => {
    if (!enabled) return;
    if (reduceMotion) {
      setRevealed(total);
      return;
    }
    if (revealed >= total) return;
    const id = setTimeout(
      () => setRevealed((r) => r + 1),
      revealed === 0 ? 120 : 55,
    );
    return () => clearTimeout(id);
  }, [revealed, total, enabled, reduceMotion]);
  return Math.min(revealed, total);
}

/**
 * The engine's failure text is written for agents. Pull out the headline and
 * the `Why:` bullets; keep the rest (Continue, Alternative…) for a disclosure.
 */
function digest(raw: string) {
  const lines = raw.split("\n");
  let headline = "";
  const reasons: string[] = [];
  let section: "lead" | "why" = "lead";
  let restStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    if (!text) continue;
    if (/^why:?$/i.test(text)) {
      section = "why";
      continue;
    }
    if (/^[A-Z][\w -]*:$/.test(text) && !/^\s/.test(lines[i])) {
      restStart = i;
      break;
    }
    if (!headline && section === "lead") {
      headline = text.replace(/^\[appa\]\s*/i, "");
      continue;
    }
    if (section === "why") {
      const bullet = /^[-*•]\s+(.*)$/.exec(text);
      if (bullet) reasons.push(bullet[1]);
      else if (reasons.length) reasons[reasons.length - 1] += ` ${text}`;
      else reasons.push(text);
    } else if (restStart < 0) {
      restStart = i;
      break;
    }
  }
  const rest = restStart >= 0 ? lines.slice(restStart).join("\n").trim() : "";
  return { headline: headline || raw.trim(), reasons, rest };
}

function triggerLabel(
  trigger: ValidationFileViewProps["fileRuns"][number]["trigger"],
  partial: boolean,
) {
  if (partial) return "this file only";
  return trigger === "policy_change"
    ? "after policy change"
    : trigger === "github_sync"
      ? "GitHub sync"
      : "run all";
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function formatSeconds(ms: number) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function usePrefersReducedMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduce(query.matches);
    const onChange = () => setReduce(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduce;
}

const outcomeLabel: Record<Outcome, string> = {
  run: "RUN",
  pass: "PASS",
  fail: "FAIL",
  warn: "CANNOT RUN",
  idle: "NOT RUN",
};
const statusGlyph: Record<FileRunStatus, string> = {
  passed: "✓",
  failed: "✗",
  cannot_run: "○",
};
const statusText: Record<FileRunStatus, string> = {
  passed: "text-green-400",
  failed: "text-red-400",
  cannot_run: "text-yellow-300",
};
const statusBar: Record<FileRunStatus, string> = {
  passed: "bg-green-500/70",
  failed: "bg-red-500",
  cannot_run: "bg-yellow-400/80",
};
const terminalGhost =
  "text-zinc-400 hover:bg-white/10 hover:text-zinc-100 dark:hover:bg-white/10";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const HISTORY_HREF = "/openappa/validation/history";

// ===========================================================================
// Status tag colours
// ===========================================================================

type FileStatus = ValidationFileViewProps["status"];

const STATUS_TEXT: Record<FileStatus, string> = {
  passed: "text-green-700 dark:text-green-400",
  failed: "text-red-700 dark:text-red-400",
  cannot_run: "text-yellow-800 dark:text-yellow-300",
  not_run: "text-muted-foreground",
};

const STATUS_TINT: Record<FileStatus, string> = {
  passed: "bg-green-500/10",
  failed: "bg-red-500/10",
  cannot_run: "bg-yellow-500/10",
  not_run: "bg-muted",
};

type PolicyTestFileResult = PolicyTestRun["files"][number];
type PolicyTestStep = PolicyTestFileResult["steps"][number];

/**
 * Prefer the reasons replay recorded for a blocked step; runs recorded before
 * replay kept them have only the engine's text to read them from.
 */
function withStepReasons<T extends { reasons: string[] }>(
  why: T | null,
  reasons: string[] | undefined,
): T | null {
  return why && reasons?.length
    ? { ...why, reasons: reasons.map(capitalize) }
    : why;
}

function capitalize(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
