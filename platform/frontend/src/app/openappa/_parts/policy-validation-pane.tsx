"use client";

import type { Monaco, OnMount } from "@monaco-editor/react";
import {
  Check,
  ChevronRight,
  Download,
  Ellipsis,
  Loader2,
  Play,
  Save,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { Editor } from "@/components/editor";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useBeforeUnloadWhileDirty } from "@/components/unsaved-changes-guard";
import {
  type PolicyTestPreview,
  usePreviewOpenAppaPolicyTest,
} from "@/lib/openappa-policy-tests.query";
import { formatDate } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import {
  APPA_EDITOR_THEMES,
  APPA_LANGUAGE_ID,
  parseAppa,
  registerAppaLanguage,
} from "./appa-language";
import { focusPolicyLine } from "./policy-decorations";
import { POLICY_EDITOR_OPTIONS } from "./policy-editor-options";
import { PolicyPaneSkeleton } from "./policy-source-pane";
import {
  useValidationInspection,
  useValidationSuite,
  type ValidationSuite,
} from "./validation-context";
import {
  latestFileResult,
  type ValidationRunStatus,
  validationFileStates,
  validationName,
  validationRunLabel,
} from "./validation-run-history";

/**
 * One validation file in the Policy editor: its source, with what its last
 * run decided drawn into the code. A failed step explains itself under its
 * `expect` line; the header runs the file, saves it and walks its runs.
 */
export function PolicyValidationPane({
  path,
  focusLine,
  repositoryUrl,
  onDeleted,
  className,
}: {
  path: string;
  focusLine?: number;
  /** Where the file is changed when the validations live in a repository. */
  repositoryUrl: string | null;
  /** The file is gone: open something else. */
  onDeleted: () => void;
  className?: string;
}) {
  const suite = useValidationSuite();
  if (!suite) return <PolicyPaneSkeleton className={className} />;
  if (!suite.collection.files.some((file) => file.path === path))
    return (
      <div className={cn("p-4 text-sm text-muted-foreground", className)}>
        <p className="font-medium text-foreground">
          This validation is not in the current set.
        </p>
        <p>It may have been renamed or deleted. Pick another file.</p>
      </div>
    );
  return (
    <ValidationFile
      // One editor state per file.
      key={path}
      suite={suite}
      path={path}
      focusLine={focusLine}
      repositoryUrl={repositoryUrl}
      onDeleted={onDeleted}
      className={className}
    />
  );
}

/**
 * Monaco paints these outside React, so they are plain CSS on the page's tokens.
 * A widget button's tooltip (the find box's Close) wraps at the editor's right
 * edge and lands on its own button, where it flickers: it keeps its one line,
 * moved in from the edge that would clip it, and lets the pointer through.
 */
export const POLICY_VALIDATION_CSS = `
.appa-v-glyph { display: flex !important; align-items: center; justify-content: center; font-family: var(--font-sans, system-ui), sans-serif; font-size: 11px; font-weight: 700; line-height: 1; }
.appa-v-glyph-pass::before { content: "\\2713"; color: var(--color-emerald-500); }
.appa-v-glyph-fail::before { content: "\\2717"; color: var(--destructive); }
.appa-v-glyph-warn::before { content: "!"; color: var(--color-amber-500); font-weight: 800; font-size: 12px; }
.appa-v-glyph-skip::before { content: "\\25CB"; color: var(--muted-foreground); opacity: 0.55; font-size: 9px; }
.appa-v-glyph-pending::before { content: "\\25CF"; color: var(--muted-foreground); font-size: 8px; animation: appa-v-pulse 0.6s ease-in-out infinite alternate; }
.appa-v-glyph-run { cursor: pointer; }
.appa-v-glyph-run::before { content: "\\25B6"; color: var(--muted-foreground); opacity: 0.35; font-size: 8px; transition: opacity 120ms, color 120ms; }
.appa-v-glyph-run:hover::before { opacity: 1; color: var(--color-emerald-500); }
.appa-v-line-fail { background-color: color-mix(in oklab, var(--destructive) 9%, transparent); }
.appa-v-line-warn { background-color: color-mix(in oklab, var(--color-amber-500) 11%, transparent); }
.appa-v-after { color: var(--muted-foreground) !important; opacity: 0.6; font-style: normal; }
.monaco-editor .monaco-hover:not(.workbench-hover), .monaco-editor .monaco-hover:not(.workbench-hover) .hover-contents, .monaco-editor .monaco-hover:not(.workbench-hover) p { font-size: 12px !important; line-height: 16px !important; }
.context-view:has(.workbench-hover.compact) { width: max-content !important; translate: -20px 0; pointer-events: none; }
.monaco-editor .monaco-editor-overlaymessage .message { font-size: 12px; line-height: 16px; padding: 2px 6px; }
.appa-v-sweep { animation: appa-v-sweep 1.1s ease-in-out infinite; }
@keyframes appa-v-pulse { from { opacity: 0.25; } to { opacity: 1; } }
@keyframes appa-v-sweep { from { transform: translateX(-100%); } to { transform: translateX(300%); } }
@media (prefers-reduced-motion: reduce) { .appa-v-sweep, .appa-v-glyph-pending::before { animation: none; } }
`;

// === Internal ===

type CodeEditor = Parameters<OnMount>[0];
type Mounted = { editor: CodeEditor; monaco: Monaco };
type ZoneAccessor = Parameters<Parameters<CodeEditor["changeViewZones"]>[0]>[0];
type ViewZone = Parameters<ZoneAccessor["addZone"]>[0];
type Run = NonNullable<ValidationSuite["history"]["data"]>[number];
type FileResult = Run["files"][number] | PolicyTestPreview["files"][number];
type Step = FileResult["steps"][number];
type Status = ValidationRunStatus | "not_run";

type InlineSpec =
  | { key: string; afterLine: number; kind: "failed"; step: Step }
  | { key: string; afterLine: number; kind: "cannot_run"; message: string };
type ZoneEntry = InlineSpec & {
  node: HTMLDivElement;
  id: string;
  zone: ViewZone;
};

function ValidationFile({
  suite,
  path,
  focusLine,
  repositoryUrl,
  onDeleted,
  className,
}: {
  suite: ValidationSuite;
  path: string;
  focusLine?: number;
  repositoryUrl: string | null;
  onDeleted: () => void;
  className?: string;
}) {
  const draftKey = `${suite.sessionKey}|${path}`;
  const saved = suite.collection.files.find((file) => file.path === path);
  const savedContent = saved?.content ?? "";
  const [content, setContent] = useState(
    () => DRAFTS.get(draftKey) ?? savedContent,
  );
  const dirty = content !== savedContent;
  // What was saved elsewhere replaces the text only while it is unedited.
  const lastSaved = useRef(savedContent);
  useEffect(() => {
    if (lastSaved.current === savedContent) return;
    setContent((current) =>
      current === lastSaved.current ? savedContent : current,
    );
    lastSaved.current = savedContent;
  }, [savedContent]);
  // An edit outlives a look at another file.
  useEffect(() => {
    if (dirty) DRAFTS.set(draftKey, content);
    else DRAFTS.delete(draftKey);
  }, [dirty, content, draftKey]);
  useBeforeUnloadWhileDirty(dirty);

  const file = useMemo(() => ({ path, content }), [path, content]);
  const previewMutation = usePreviewOpenAppaPolicyTest();
  const [preview, setPreview] = useState<{
    content: string;
    run: PolicyTestPreview;
  } | null>(null);
  // A test of the draft describes the text it tested; editing again drops it.
  const previewRun = preview?.content === content ? preview.run : null;
  const [viewRunId, setViewRunId] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const runs = suite.history.data ?? EMPTY_RUNS;
  const fileRuns = useMemo(
    () =>
      runs
        .flatMap((run) => {
          const result = run.files.find((item) => item.path === path);
          return result ? [{ run, result }] : [];
        })
        .slice(0, RUN_DOTS)
        .reverse(),
    [runs, path],
  );
  const latest = fileRuns.at(-1) ?? null;
  const viewed =
    // An edit leaves the run being looked at: the text is no longer its text.
    !dirty && viewRunId && viewRunId !== latest?.run.id
      ? (fileRuns.find((item) => item.run.id === viewRunId) ?? null)
      : null;
  const recorded = useMemo(
    () => ({
      latest: latestFileResult({ path }, runs),
      state: validationFileStates([{ path }], runs).get(path),
    }),
    [runs, path],
  );

  // An edited file shows no recorded result: its lines no longer match.
  const result: FileResult | null = viewed
    ? viewed.result
    : previewRun
      ? (previewRun.files[0] ?? null)
      : dirty
        ? null
        : (recorded.latest?.result ?? null);
  const status: Status = viewed
    ? viewed.result.status
    : previewRun
      ? (result?.status ?? "not_run")
      : dirty
        ? "not_run"
        : (recorded.state?.status ?? "not_run");
  const fileError = viewed
    ? (viewed.result.error ?? viewed.run.executionError ?? null)
    : previewRun
      ? (result?.error ?? null)
      : dirty
        ? null
        : (recorded.state?.error ?? null);

  const running =
    suite.runningAll || suite.runningPath === path || previewMutation.isPending;
  const busy = suite.busy || previewMutation.isPending;
  const canEdit = suite.canWrite && !suite.github;
  const usable =
    !suite.sourceChanged && !suite.collection.error && !suite.loadError;
  const runnable = suite.canWrite && !busy && usable;

  const inspection = useValidationInspection(
    useMemo(() => [file], [file]),
    usable,
  );
  const syntaxError = inspection.summaries?.[0]?.error ?? null;

  const run = useCallback(() => {
    if (!runnable) return;
    setViewRunId(null);
    setPreview(null);
    // A saved file runs for real and lands in run history; a draft can only
    // be tried in the editor.
    if (!dirty) {
      suite.runFile(path);
      return;
    }
    const tested = content;
    previewMutation.mutate(
      {
        files: [{ path, content: tested }],
        sourceVersion: suite.baseline.version,
        directory: suite.baseline.directory,
      },
      {
        onSuccess: (next) => {
          if (next) setPreview({ content: tested, run: next });
        },
      },
    );
  }, [runnable, dirty, suite, path, content, previewMutation]);
  const save = useCallback(() => {
    if (!canEdit || !dirty || busy || !usable) return;
    suite.save(path, { path, content }, suite.baseline.version, () =>
      DRAFTS.delete(draftKey),
    );
  }, [canEdit, dirty, busy, usable, suite, path, content, draftKey]);

  const notices: { tone: "warn" | "error"; text: string }[] = [
    ...(suite.sourceChanged
      ? [
          {
            tone: "warn" as const,
            text: "The validations changed somewhere else. Reload the page to work on the current set.",
          },
        ]
      : []),
    ...(syntaxError
      ? [{ tone: "error" as const, text: `Invalid syntax: ${syntaxError}` }]
      : []),
    ...(previewMutation.isError
      ? [
          {
            tone: "error" as const,
            text: `The draft could not be tested: ${previewMutation.error.message}`,
          },
        ]
      : []),
    // A run that decided nothing about any step has no line to sit on.
    ...(fileError && !result?.steps.length
      ? [{ tone: "warn" as const, text: `Cannot run: ${fileError}` }]
      : []),
  ];

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <FileHeader
        name={validationName(file)}
        status={status}
        result={result}
        running={running}
        dirty={dirty}
        previewed={previewRun !== null}
        viewing={
          viewed
            ? {
                label: formatDate({
                  date: viewed.run.createdAt,
                  dateFormat: "MMM d, HH:mm",
                }),
                onBack: () => setViewRunId(null),
              }
            : null
        }
        runs={fileRuns}
        selectedRunId={viewed?.run.id ?? latest?.run.id ?? null}
        onSelectRun={setViewRunId}
        run={{ disabled: !runnable, onClick: run }}
        save={
          canEdit
            ? { disabled: !dirty || busy || !usable, onClick: save }
            : null
        }
        runAll={{
          disabled: !suite.runnable,
          onClick: () => {
            setViewRunId(null);
            suite.runAll();
          },
        }}
        onExport={() => exportValidationFile(file)}
        onDelete={canEdit && !busy ? () => setDeleteOpen(true) : null}
      />
      {notices.map((notice) => (
        <p
          key={notice.text}
          role={notice.tone === "error" ? "alert" : "status"}
          className={cn(
            "flex shrink-0 items-start gap-2 border-b px-3 py-1 text-xs",
            notice.tone === "error"
              ? "bg-destructive/10 text-destructive"
              : "bg-amber-500/10 text-amber-700 dark:text-amber-400",
          )}
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0">{notice.text}</span>
        </p>
      ))}
      <ResultEditor
        path={path}
        content={content}
        onChange={setContent}
        readOnly={!canEdit || busy}
        readOnlyMessage={
          suite.github
            ? repositoryUrl
              ? `Read-only. [Edit in the repository](${repositoryUrl})`
              : "Read-only. Change this validation in its repository."
            : !suite.canWrite
              ? "Read-only. Ask an administrator to change this validation."
              : null
        }
        result={result}
        running={running}
        focusLine={focusLine}
        onRun={run}
        onSave={save}
      />
      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${path}?`}
        description="This validation file will be deleted."
        isPending={suite.busy}
        confirmDisabled={!canEdit || !usable}
        onConfirm={() =>
          suite.deleteFiles([path], () => {
            DRAFTS.delete(draftKey);
            setDeleteOpen(false);
            onDeleted();
          })
        }
      />
    </div>
  );
}

/** The source, with a run's result marked in its gutter and between its lines. */
function ResultEditor({
  path,
  content,
  onChange,
  readOnly,
  readOnlyMessage,
  result,
  running,
  focusLine,
  onRun,
  onSave,
}: {
  /** What typing into a read-only file answers, as Markdown; null for the editor's own words. */
  readOnlyMessage: string | null;
  path: string;
  content: string;
  onChange: (content: string) => void;
  readOnly: boolean;
  result: FileResult | null;
  running: boolean;
  focusLine?: number;
  onRun: () => void;
  onSave: () => void;
}) {
  const [mounted, setMounted] = useState<Mounted | null>(null);
  const [zones, setZones] = useState<ZoneEntry[]>([]);
  const actions = useRef({ onRun, onSave });
  actions.current = { onRun, onSave };

  // Each step, on the lines its call and its `expect` are written.
  const steps = useMemo(() => {
    const parsed = parseAppa(content.split("\n")).steps;
    return (result?.steps ?? []).flatMap((step) => {
      const at = parsed.find(
        (item) => item.line === step.line || item.endLine === step.line,
      );
      return at ? [{ step, callLine: at.line, expectLine: at.endLine }] : [];
    });
  }, [content, result]);
  const callLines = useRef<Set<number>>(new Set());
  callLines.current = useMemo(
    () =>
      new Set(parseAppa(content.split("\n")).steps.map((step) => step.line)),
    [content],
  );
  const stepMs =
    result?.durationMs && result.steps.length
      ? Math.max(1, Math.round(result.durationMs / result.steps.length))
      : null;

  // Gutter marks, the tint on a failed line and the faint result after a
  // passed `expect`.
  useEffect(() => {
    if (!mounted) return;
    const { editor, monaco } = mounted;
    const model = editor.getModel();
    if (!model) return;
    const lineCount = model.getLineCount();
    const at = (line: number, column = 1) =>
      new monaco.Range(line, column, line, column);
    const marked = new Set(steps.map((item) => item.callLine));
    const decorations = [
      // Every call can run the file, with or without a result.
      ...[...callLines.current]
        .filter((line) => line <= lineCount && !marked.has(line))
        .map((line) => ({
          range: at(line),
          options: {
            glyphMarginClassName: "appa-v-glyph appa-v-glyph-run",
            glyphMarginHoverMessage: { value: "Run this file" },
          },
        })),
      ...steps
        .filter((item) => item.expectLine <= lineCount)
        .flatMap(({ step, callLine, expectLine }) => {
          const status = running ? "pending" : step.status;
          const broken = !running && step.status === "cannot_run" && step.error;
          return [
            {
              range: at(callLine),
              options: {
                isWholeLine: Boolean(broken),
                className: broken ? "appa-v-line-warn" : undefined,
                glyphMarginClassName: broken
                  ? "appa-v-glyph appa-v-glyph-warn"
                  : "appa-v-glyph appa-v-glyph-run",
                // The card under the line already says what is wrong.
                glyphMarginHoverMessage: broken
                  ? undefined
                  : { value: "Run this file" },
              },
            },
            {
              range: at(expectLine),
              options: {
                isWholeLine: true,
                className: status === "failed" ? "appa-v-line-fail" : undefined,
                glyphMarginClassName: `appa-v-glyph appa-v-glyph-${GLYPH[status]}`,
                glyphMarginHoverMessage: { value: HOVER[status] },
              },
            },
            {
              range: at(expectLine, model.getLineMaxColumn(expectLine)),
              options: {
                after: {
                  content:
                    status === "pending"
                      ? "    running…"
                      : status === "passed"
                        ? `    ${step.actual ?? step.expected}${stepMs ? ` · ${stepMs}ms` : ""}`
                        : status === "cannot_run"
                          ? "    not run"
                          : "",
                  inlineClassName: "appa-v-after",
                },
                showIfCollapsed: true,
              },
            },
          ];
        }),
    ];
    const collection = editor.createDecorationsCollection(decorations);
    return () => collection.clear();
  }, [mounted, steps, running, stepMs]);

  // What a step decided sits under its `expect` line, in the code.
  useEffect(() => {
    if (!mounted || running) return;
    const { editor } = mounted;
    const specs = steps.flatMap(
      ({ step, callLine, expectLine }): InlineSpec[] =>
        step.status === "failed"
          ? [
              {
                key: `step-${expectLine}`,
                afterLine: expectLine,
                kind: "failed",
                step,
              },
            ]
          : step.status === "cannot_run" && step.error
            ? [
                {
                  key: `error-${callLine}`,
                  afterLine: callLine,
                  kind: "cannot_run",
                  message: step.error,
                },
              ]
            : [],
    );
    if (specs.length === 0) return;
    const entries: ZoneEntry[] = specs.map((spec) => {
      const node = document.createElement("div");
      // The zone layer sits under the text layer: lift it so it takes clicks.
      node.style.zIndex = "10";
      node.style.pointerEvents = "auto";
      return {
        ...spec,
        node,
        id: "",
        zone: {
          afterLineNumber: spec.afterLine,
          heightInPx: 60,
          domNode: node,
        },
      };
    });
    editor.changeViewZones((accessor) => {
      for (const entry of entries) entry.id = accessor.addZone(entry.zone);
    });
    setZones(entries);
    return () => {
      editor.changeViewZones((accessor) => {
        for (const entry of entries) accessor.removeZone(entry.id);
      });
      setZones([]);
    };
  }, [mounted, steps, running]);

  const resize = useCallback(
    (entry: ZoneEntry, height: number) => {
      if (!mounted || entry.zone.heightInPx === height) return;
      entry.zone.heightInPx = height;
      mounted.editor.changeViewZones((accessor) =>
        accessor.layoutZone(entry.id),
      );
    },
    [mounted],
  );

  useEffect(() => {
    if (!mounted) return;
    return focusPolicyLine(mounted.editor, focusLine);
  }, [mounted, focusLine]);

  // The play mark beside a call runs the file, as Cmd/Ctrl+Enter does;
  // Cmd/Ctrl+S saves it.
  useEffect(() => {
    if (!mounted) return;
    const { editor, monaco } = mounted;
    const listener = editor.onMouseDown((event) => {
      const line = event.target.position?.lineNumber;
      if (
        event.target.type ===
          monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN &&
        line &&
        callLines.current.has(line)
      )
        actions.current.onRun();
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () =>
      actions.current.onRun(),
    );
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
      actions.current.onSave(),
    );
    return () => listener.dispose();
  }, [mounted]);

  return (
    <>
      <div className="relative min-h-60 flex-1">
        <div className="absolute inset-0">
          <Editor
            height="100%"
            language={APPA_LANGUAGE_ID}
            themes={APPA_EDITOR_THEMES}
            beforeMount={registerAppaLanguage}
            path={`validation/${path}`}
            value={content}
            onChange={(value) => onChange(value ?? "")}
            onMount={(editor, monaco) => setMounted({ editor, monaco })}
            options={{
              ...POLICY_EDITOR_OPTIONS,
              fontSize: 13,
              padding: { top: 10, bottom: 10 },
              readOnly,
              readOnlyMessage: readOnlyMessage
                ? { value: readOnlyMessage }
                : undefined,
              glyphMargin: true,
              folding: false,
              renderLineHighlight: "none",
              ariaLabel: `Policy validation ${path}`,
            }}
          />
        </div>
      </div>
      {zones.map((entry) =>
        createPortal(
          <InlineOutcome
            entry={entry}
            onHeight={(height) => resize(entry, height)}
          />,
          entry.node,
          entry.key,
        ),
      )}
    </>
  );
}

function FileHeader({
  name,
  status,
  result,
  running,
  dirty,
  previewed,
  viewing,
  runs,
  selectedRunId,
  onSelectRun,
  run,
  save,
  runAll,
  onExport,
  onDelete,
}: {
  name: string;
  status: Status;
  result: FileResult | null;
  running: boolean;
  dirty: boolean;
  /** The result shown is a test of the unsaved text. */
  previewed: boolean;
  /** An earlier run's result is shown instead of the latest. */
  viewing: { label: string; onBack: () => void } | null;
  runs: { run: Run; result: Run["files"][number] }[];
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  run: { disabled: boolean; onClick: () => void };
  save: { disabled: boolean; onClick: () => void } | null;
  runAll: { disabled: boolean; onClick: () => void };
  onExport: () => void;
  onDelete: (() => void) | null;
}) {
  const look = STATUS[status];
  const total = result?.steps.length ?? 0;
  const passed =
    result?.steps.filter((step) => step.status === "passed").length ?? 0;
  const detail = running
    ? null
    : !result
      ? dirty
        ? "Unsaved changes"
        : null
      : status === "cannot_run"
        ? "No step ran"
        : `${passed} of ${total} step${total === 1 ? "" : "s"} passed${
            result.durationMs ? ` · ${result.durationMs}ms` : ""
          }${previewed ? " · draft" : ""}`;
  return (
    <div className="relative flex h-8 shrink-0 items-center gap-2 border-b pr-1.5 pl-3 text-xs">
      <span
        data-testid="validation-status"
        className={cn(
          "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium leading-none",
          running ? "bg-muted text-muted-foreground" : [look.text, look.tint],
        )}
      >
        {running ? (
          <Loader2 className="size-3 animate-spin" aria-hidden />
        ) : (
          <StatusIcon status={status} className="size-3" />
        )}
        <span>{running ? "Running" : look.label}</span>
      </span>
      <span className="min-w-0 truncate font-medium" title={name}>
        {name}
      </span>
      {detail && (
        <span className="hidden shrink-0 text-[11px] tabular-nums text-muted-foreground lg:inline">
          {detail}
        </span>
      )}
      {viewing && (
        <span className="flex shrink-0 items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[11px] leading-none text-amber-700 dark:text-amber-400">
          <span>{`Viewing ${viewing.label}`}</span>
          <UnstyledButton
            onClick={viewing.onBack}
            className="underline underline-offset-2 outline-none hover:text-foreground focus-visible:text-foreground"
          >
            Back to latest
          </UnstyledButton>
        </span>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {/* A draft has no place in the file's recorded runs. */}
        {!dirty && runs.length > 0 && (
          <RunStrip
            runs={runs}
            selectedId={selectedRunId}
            onSelect={onSelectRun}
          />
        )}
        <div className="flex items-center gap-0.5">
          {save && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={save.disabled}
                    onClick={save.onClick}
                    className="h-6 px-2 text-xs"
                  >
                    <Save className="size-3" />
                    <span>Save</span>
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">Save (⌘S)</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={run.disabled}
                  onClick={run.onClick}
                  className="h-6 px-2 text-xs"
                >
                  {running ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Play className="size-3" />
                  )}
                  <span>{dirty ? "Test draft" : "Run file"}</span>
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-52">
              {dirty
                ? "Try the unsaved text. Nothing is recorded. (⌘↵)"
                : "Run this file (⌘↵)"}
            </TooltipContent>
          </Tooltip>
          <Button
            size="xs"
            variant="ghost"
            disabled={runAll.disabled}
            onClick={runAll.onClick}
            className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            Run all
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="More file actions"
                className="size-6 text-muted-foreground hover:text-foreground"
              >
                <Ellipsis className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onExport}>
                <Download className="size-4" />
                <span>Download file</span>
              </DropdownMenuItem>
              {onDelete && (
                <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                  <Trash2 className="size-4" />
                  <span>Delete file</span>
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {running && (
        <span
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-px overflow-hidden"
        >
          <span className="appa-v-sweep block h-full w-1/3 bg-primary" />
        </span>
      )}
    </div>
  );
}

/** The file's last runs, oldest first: one dot per run, each opening its result. */
function RunStrip({
  runs,
  selectedId,
  onSelect,
}: {
  runs: { run: Run; result: Run["files"][number] }[];
  selectedId: string | null;
  onSelect: (runId: string) => void;
}) {
  return (
    <div className="hidden items-center gap-1.5 sm:flex">
      <span className="hidden text-[10.5px] text-muted-foreground xl:inline">
        {runs.length === 1 ? "Last run" : `Last ${runs.length} runs`}
      </span>
      <ol aria-label="This file's last runs" className="flex items-center">
        {runs.map(({ run, result }) => {
          const look = STATUS[result.status];
          const when = formatDate({
            date: run.createdAt,
            dateFormat: "MMM d, HH:mm",
          });
          return (
            <li key={run.id}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <UnstyledButton
                    aria-label={`Show the run of ${when}: ${look.label}`}
                    aria-pressed={run.id === selectedId}
                    onClick={() => onSelect(run.id)}
                    className="group/run flex h-5 w-3 cursor-pointer items-center justify-center outline-none"
                  >
                    <span
                      className={cn(
                        "rounded-full transition-transform group-hover/run:scale-150 group-focus-visible/run:scale-150",
                        look.dot,
                        run.id === selectedId
                          ? "size-2 ring-2 ring-background outline outline-1 outline-foreground/60"
                          : "size-1.5 opacity-80",
                      )}
                    />
                  </UnstyledButton>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-52 space-y-0.5">
                  <p className="flex items-center gap-1.5 font-medium">
                    <span
                      aria-hidden
                      className={cn("size-1.5 rounded-full", look.dot)}
                    />
                    <span>{`${look.label} · ${when}`}</span>
                  </p>
                  <p className="opacity-80">
                    {`${validationRunLabel(run)} · policy revision ${run.policyRevision}`}
                  </p>
                  <p className="opacity-80">Click to see this run's result</p>
                </TooltipContent>
              </Tooltip>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function StatusIcon({
  status,
  className,
}: {
  status: Status;
  className?: string;
}) {
  const Icon =
    status === "passed"
      ? Check
      : status === "failed"
        ? X
        : status === "cannot_run"
          ? TriangleAlert
          : Play;
  return <Icon className={cn("shrink-0", className)} aria-hidden />;
}

/** What a step decided, drawn between two lines of the source. */
function InlineOutcome({
  entry,
  onHeight,
}: {
  entry: ZoneEntry;
  onHeight: (height: number) => void;
}) {
  const [whyOpen, setWhyOpen] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const report = useRef(onHeight);
  report.current = onHeight;
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => report.current(Math.ceil(element.offsetHeight));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const failed = entry.kind === "failed";
  const reasons = failed ? (entry.step.reasons ?? []) : [];
  return (
    <div ref={box} className="select-text pt-0.5 pr-6 pb-2 font-sans">
      <div
        className={cn(
          "max-w-3xl overflow-hidden rounded-md border border-l-2 text-[12px] leading-5 text-foreground",
          failed
            ? "border-destructive/25 border-l-destructive bg-destructive/[0.04]"
            : "border-amber-500/30 border-l-amber-500 bg-amber-500/[0.06]",
        )}
      >
        {failed ? (
          <div className="flex h-7 items-center gap-1.5 px-2">
            <X className="size-3.5 shrink-0 text-destructive" aria-hidden />
            <span className="text-muted-foreground">expected</span>
            <Decision>{entry.step.expected}</Decision>
            <span className="text-muted-foreground">· got</span>
            <Decision wrong>{entry.step.actual ?? "no decision"}</Decision>
            {reasons.length > 0 && (
              <UnstyledButton
                aria-expanded={whyOpen}
                onClick={() => setWhyOpen((value) => !value)}
                className="ml-auto flex h-5 shrink-0 items-center gap-0.5 rounded-sm px-1 text-[11px] text-muted-foreground outline-none hover:bg-destructive/10 hover:text-foreground focus-visible:bg-destructive/10"
              >
                <span>Why?</span>
                <ChevronRight
                  className={cn(
                    "size-3 transition-transform",
                    whyOpen && "rotate-90",
                  )}
                  aria-hidden
                />
              </UnstyledButton>
            )}
          </div>
        ) : (
          <div className="flex items-start gap-1.5 px-2 py-1">
            <TriangleAlert
              className="mt-[3px] size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
              aria-hidden
            />
            <p className="min-w-0">
              <span className="font-medium">Cannot run.</span>{" "}
              <span className="text-foreground/80">{entry.message}</span>
            </p>
          </div>
        )}
        {failed && whyOpen && reasons.length > 0 && (
          <ol className="space-y-0.5 border-t border-destructive/15 px-2 py-1.5">
            {reasons.map((reason, index) => (
              <li key={reason} className="flex gap-2 text-foreground/80">
                <span className="w-3.5 shrink-0 text-center font-mono text-[10.5px] text-muted-foreground">
                  {index + 1}
                </span>
                <span className="min-w-0">{reason}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function Decision({
  wrong,
  children,
}: {
  wrong?: boolean;
  children: ReactNode;
}) {
  return (
    <code
      className={cn(
        "rounded-sm border px-1 font-mono text-[11.5px] leading-[18px]",
        wrong
          ? "border-destructive/30 bg-destructive/10 font-medium text-destructive"
          : "bg-background text-foreground",
      )}
    >
      {children}
    </code>
  );
}

/** Downloads one validation file, e.g. a draft to keep before reloading. */
function exportValidationFile(file: { path: string; content: string }) {
  const url = URL.createObjectURL(
    new Blob([file.content], { type: "text/plain;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.path.split("/").pop() ?? "validation.appa";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** How each outcome is named and coloured wherever a validation is listed. */
export const VALIDATION_STATUS_LOOK = {
  passed: {
    label: "Passed",
    dot: "bg-emerald-500",
    text: "text-emerald-600 dark:text-emerald-400",
    tint: "bg-emerald-500/10",
  },
  failed: {
    label: "Failed",
    dot: "bg-destructive",
    text: "text-destructive",
    tint: "bg-destructive/10",
  },
  cannot_run: {
    label: "Cannot run",
    dot: "bg-amber-500",
    text: "text-amber-700 dark:text-amber-400",
    tint: "bg-amber-500/10",
  },
  not_run: {
    label: "Not run",
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
    tint: "bg-muted",
  },
} as const satisfies Record<
  Status,
  { label: string; dot: string; text: string; tint: string }
>;
const STATUS = VALIDATION_STATUS_LOOK;

const GLYPH = {
  passed: "pass",
  failed: "fail",
  cannot_run: "skip",
  pending: "pending",
} as const;

const HOVER = {
  passed: "Passed",
  failed: "Failed",
  cannot_run: "Not run: the file could not run",
  pending: "Running",
} as const;

/** How many of a file's runs its header shows. */
const RUN_DOTS = 8;
const EMPTY_RUNS: Run[] = [];
/** Unsaved text per file, so an edit survives opening another file. */
const DRAFTS = new Map<string, string>();
