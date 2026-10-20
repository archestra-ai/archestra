"use client";

import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  ExternalLink,
  History,
  Info,
  Loader2,
  LockKeyhole,
  MessageCircle,
  MoreHorizontal,
  Play,
  Search,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type CSSProperties, type ReactNode, useMemo, useState } from "react";
import {
  openRowOnPlainClick,
  RowClickShield,
} from "@/components/agent-pages/row-click-shield";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import type { PolicyTestRun } from "@/lib/openappa-policy-tests.query";
import { formatCompactRelativeTime, formatDate } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import { useManagedValidationsLink } from "../../_parts/github-managed-policy-notice";
import {
  OpenAppaChatButton,
  useOpenAppaChatLaunch,
} from "../../_parts/openappa-chat-button";
import { OpenAppaPageAction } from "../../_parts/openappa-page-action";
import {
  validationFileStates,
  validationName,
} from "../../_parts/validation-run-history";
import { useValidation, validationFileHref } from "./validation-context";
import {
  statusLabel,
  ValidationNotices,
  ValidationRunNotices,
} from "./validation-parts";

// ===========================================================================
// Refined table: one primary action, a summary strip that doubles as the
// status filter, and rows that say why a file fails instead of a pill.
// ===========================================================================

export function ValidationList({
  runAll,
  runFile,
  openRun,
  requestDelete,
}: {
  /** Start a full run and follow it in the runner panel. */
  runAll: () => void;
  runFile: (path: string) => void;
  /** Open a recorded run in the runner panel. */
  openRun: (runId: string) => void;
  /** Ask to delete these files; undefined when files are read-only. */
  requestDelete?: (paths: string[]) => void;
}) {
  const suite = useValidation();
  const router = useRouter();
  const rows = useRows();
  // Filters live in the URL so returning from a file restores them.
  const params = useSearchParams();
  const filter: FileStatus | "all" =
    STRIP.find((item) => item.status === params.get("status"))?.status ?? "all";
  const [query, setQueryState] = useState(() => params.get("search") ?? "");
  function updateQuery(next: { status?: string | null; search?: string }) {
    const search = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value) search.set(key, value);
      else search.delete(key);
    }
    router.replace(`/openappa/validation${search.size ? `?${search}` : ""}`, {
      scroll: false,
    });
  }
  function setFilter(next: FileStatus | "all") {
    updateQuery({ status: next === "all" ? null : next });
  }
  function setQuery(next: string) {
    setQueryState(next);
    updateQuery({ search: next.trim() });
  }
  const loading = !suite.history.data && suite.history.isLoading;
  const lastRun = suite.history.data?.[0];
  const canDelete = canDeleteValidations(suite);
  const lastRunTitle = lastRun
    ? `Last run ${formatDate({ date: lastRun.createdAt })} · policy revision ${lastRun.policyRevision}. Open it.`
    : "";

  const counts = useMemo(() => {
    const c: Record<FileStatus, number> = {
      passed: 0,
      failed: 0,
      cannot_run: 0,
      not_run: 0,
    };
    for (const row of rows) c[row.status] += 1;
    return c;
  }, [rows]);
  const stripItems = STRIP.filter(
    (item) => item.status === "passed" || counts[item.status] > 0,
  );

  const needle = query.trim().toLowerCase();
  const visible = rows
    .filter((row) => filter === "all" || row.status === filter)
    .filter(
      (row) =>
        !needle ||
        row.name.toLowerCase().includes(needle) ||
        row.path.toLowerCase().includes(needle),
    )
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);

  return (
    <div className="-mt-2 space-y-4">
      <OpenAppaPageAction>
        <HeaderActions runAll={runAll} />
      </OpenAppaPageAction>

      <ValidationNotices hideManagedChip />
      <ValidationRunNotices />
      {suite.inspectionError && (
        <InlineNotice variant="error">
          <Info />
          <span className="font-medium">
            Could not inspect validation files
          </span>
          <InlineNoticeText>{suite.inspectionError.message}</InlineNoticeText>
        </InlineNotice>
      )}

      {rows.length === 0 ? (
        <EmptySuite />
      ) : (
        <>
          {/* Summary strip: the counts are the status filter. On a phone
              they are equal tiles on one row, so they never wrap into a
              ragged line; from `sm` up they read inline, dot-separated. */}
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3 sm:gap-y-2">
            <div className="flex flex-col gap-2 sm:-ml-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-0.5">
              {loading ? (
                <Skeleton className="h-14 w-full sm:ml-2 sm:h-5 sm:w-64" />
              ) : (
                <div
                  style={
                    { "--strip-count": stripItems.length } as CSSProperties
                  }
                  className="grid grid-cols-[repeat(var(--strip-count),minmax(0,1fr))] gap-2 sm:flex sm:items-center sm:gap-0.5"
                >
                  {stripItems.map((item, index) => {
                    const active = filter === item.status;
                    return (
                      <span
                        key={item.status}
                        className="contents sm:flex sm:items-center"
                      >
                        {index > 0 && (
                          <span
                            aria-hidden
                            className="hidden px-0.5 text-muted-foreground/50 sm:inline"
                          >
                            ·
                          </span>
                        )}
                        <Button
                          size="xs"
                          variant="ghost"
                          aria-pressed={active}
                          onClick={() =>
                            setFilter(active ? "all" : item.status)
                          }
                          className={cn(
                            "relative grid h-auto min-w-0 grid-cols-[auto_minmax(0,1fr)] justify-items-start gap-x-1.5 gap-y-0.5 rounded-lg border px-3 py-2 text-left font-normal text-muted-foreground has-[>svg]:px-3",
                            "sm:inline-flex sm:h-7 sm:rounded-md sm:border-0 sm:px-2 sm:py-0 sm:text-sm sm:has-[>svg]:px-1.5",
                            active &&
                              "border-foreground/30 bg-muted text-foreground hover:bg-muted dark:hover:bg-muted",
                          )}
                        >
                          <StatusGlyph
                            status={item.status}
                            className="size-3.5"
                          />
                          <span className="text-base font-medium tabular-nums text-foreground sm:text-sm">
                            {counts[item.status]}
                          </span>{" "}
                          <span className="col-span-2 truncate text-xs sm:text-sm">
                            {item.label}
                          </span>
                          {active && (
                            <X className="absolute top-2 right-2 size-3 opacity-60 sm:static" />
                          )}
                        </Button>
                      </span>
                    );
                  })}
                </div>
              )}
              {lastRun && (
                <span className="block text-xs text-muted-foreground first-letter:uppercase sm:flex sm:items-center sm:pl-1 sm:text-sm">
                  <span
                    aria-hidden
                    className="hidden pr-2 text-muted-foreground/50 sm:inline"
                  >
                    ·
                  </span>
                  <span>last run&nbsp;</span>
                  <UnstyledButton
                    onClick={() => openRun(lastRun.id)}
                    title={lastRunTitle}
                    aria-label={`Last run ${formatCompactRelativeTime(lastRun.createdAt)}. Open it`}
                    className="underline-offset-4 hover:text-foreground hover:underline"
                  >
                    {formatCompactRelativeTime(lastRun.createdAt)}
                  </UnstyledButton>
                </span>
              )}
            </div>

            <div className="ml-auto flex w-full items-center gap-2 sm:w-auto">
              <div className="relative min-w-0 flex-1 sm:w-52 sm:flex-none">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search"
                  aria-label="Search validations"
                  className="h-8 pl-8"
                />
              </div>
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-9 w-10 pr-0 pl-4 md:pr-0">
                    <span className="sr-only">Status</span>
                  </TableHead>
                  <TableHead className="h-9 text-xs font-medium text-muted-foreground">
                    Validation
                  </TableHead>
                  <TableHead className="h-9 w-[76px] text-xs font-medium text-muted-foreground sm:w-24">
                    Last run
                  </TableHead>
                  <TableHead className="h-9 w-[72px]">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((row, index) => {
                  const running = suite.runningPath === row.path;
                  const href = validationFileHref(row.path);
                  const tone = row.reason ? REASON_TONE[row.status] : null;
                  return (
                    <TableRow
                      key={row.path}
                      className="group animate-in cursor-pointer fade-in duration-300"
                      style={{
                        animationDelay: `${Math.min(index, 12) * 25}ms`,
                        animationFillMode: "both",
                      }}
                      onClick={(event) =>
                        openRowOnPlainClick(event, () => router.push(href))
                      }
                    >
                      <TableCell className="py-3 pr-0 pl-4 align-top md:pr-0">
                        <div className="flex h-5 items-center">
                          <StatusGlyph
                            status={running ? "running" : row.status}
                            className="size-4"
                          />
                          <span className="sr-only">
                            {running ? "Running" : statusLabel(row.status)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="min-w-0 py-3">
                        <RowClickShield>
                          <Link
                            href={href}
                            className="block truncate text-sm leading-5 font-medium hover:underline hover:underline-offset-4"
                          >
                            {row.name}
                          </Link>
                        </RowClickShield>
                        {row.reason && tone ? (
                          <p
                            className={cn("mt-0.5 truncate text-xs", tone)}
                            title={row.reasonFull || row.reason}
                          >
                            {row.line !== null && (
                              <span className="font-mono opacity-80">
                                L{row.line}
                              </span>
                            )}
                            {row.line !== null && (
                              <span aria-hidden className="px-1 opacity-50">
                                ·
                              </span>
                            )}
                            {row.reason}
                          </p>
                        ) : (
                          <p
                            className="mt-0.5 truncate font-mono text-xs text-muted-foreground/80"
                            title={row.path}
                          >
                            {row.path}
                          </p>
                        )}
                      </TableCell>
                      <TableCell className="py-3 align-top">
                        {!running && row.runAt && row.runId ? (
                          <RowClickShield className="flex h-5 items-center">
                            <UnstyledButton
                              onClick={() => row.runId && openRun(row.runId)}
                              title={formatDate({ date: row.runAt })}
                              aria-label={`${row.name}: last run ${formatCompactRelativeTime(row.runAt)}. Open run`}
                              className="truncate text-xs leading-5 text-muted-foreground tabular-nums underline-offset-4 hover:text-foreground hover:underline"
                            >
                              {formatCompactRelativeTime(row.runAt)}
                            </UnstyledButton>
                          </RowClickShield>
                        ) : (
                          <span className="block h-5 truncate text-xs leading-5 text-muted-foreground tabular-nums">
                            {running ? "Running…" : "Never"}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="py-2.5 pr-3 align-top md:pr-3">
                        <RowClickShield
                          className={cn(
                            "flex justify-end gap-0.5 transition-opacity",
                            running
                              ? "opacity-100"
                              : "opacity-0 group-hover:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100 [@media(hover:none)]:opacity-100",
                          )}
                        >
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            aria-label={`Run ${row.name}`}
                            title={
                              suite.runnable
                                ? "Run this validation"
                                : suite.busy
                                  ? "Wait for the current run to finish"
                                  : "Running needs policy update permission"
                            }
                            disabled={!suite.runnable}
                            onClick={() => runFile(row.path)}
                          >
                            {running ? (
                              <Loader2 className="animate-spin" />
                            ) : (
                              <Play />
                            )}
                          </Button>
                          {requestDelete && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  size="icon-xs"
                                  variant="ghost"
                                  aria-label={`More actions for ${row.name}`}
                                >
                                  <MoreHorizontal />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-44">
                                <DropdownMenuItem
                                  variant="destructive"
                                  disabled={!canDelete}
                                  onSelect={() => requestDelete([row.path])}
                                >
                                  <Trash2 />
                                  <span>Delete</span>
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </RowClickShield>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {visible.length === 0 && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={4} className="py-10 text-center">
                      <p className="text-sm text-muted-foreground">
                        {needle
                          ? `No validations match “${query.trim()}”.`
                          : filter === "all"
                            ? "No validations."
                            : EMPTY_FILTER[filter]}
                      </p>
                      <Button
                        size="xs"
                        variant="link"
                        className="mt-1"
                        onClick={() => {
                          setQueryState("");
                          updateQuery({ status: null, search: "" });
                        }}
                      >
                        Show all
                      </Button>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}

export function canDeleteValidations(suite: ReturnType<typeof useValidation>) {
  return (
    !suite.github &&
    suite.canWrite &&
    !suite.busy &&
    !suite.sourceChanged &&
    !suite.loadError &&
    !suite.collection.error
  );
}

// ===========================================================================
// Header: Run all + one "…" menu
// ===========================================================================

function HeaderActions({ runAll }: { runAll: () => void }) {
  const { files, runnable, runningAll, busy, github, collection } =
    useValidation();
  const managed = useManagedValidationsLink(collection.activeDirectory);
  const explain = useChatMenuLink("explainValidations");
  const write = useChatMenuLink("writeValidations", {
    guardrailsPolicy: ["read", "update"],
  });
  return (
    <div className="flex items-center gap-2">
      <Button size="sm" disabled={!runnable || !files.length} onClick={runAll}>
        {runningAll ? <Loader2 className="animate-spin" /> : <Play />}
        <span>Run all</span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="More validation actions"
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <ChatMenuItem link={explain} disabled={busy}>
            <Info />
            <span>Explain validations</span>
          </ChatMenuItem>
          {write.allowed && (
            <ChatMenuItem link={write} disabled={busy}>
              <MessageCircle />
              <span>Write a validation</span>
            </ChatMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/openappa/validation/history">
              <History />
              <span>Run history</span>
            </Link>
          </DropdownMenuItem>
          {github && managed.href && (
            <DropdownMenuItem asChild>
              <a href={managed.href} target="_blank" rel="noopener noreferrer">
                <LockKeyhole />
                <span>{managed.label}</span>
                <ExternalLink className="ml-auto" />
                <span className="sr-only">(opens in new tab)</span>
              </a>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

type ChatLink = { href: string | null; allowed: boolean };

function useChatMenuLink(
  promptKey: "explainValidations" | "writeValidations",
  permissions?: Parameters<typeof useOpenAppaChatLaunch>[0]["permissions"],
): ChatLink {
  const launch = useOpenAppaChatLaunch({
    subject: { kind: "prompt", promptKey },
    permissions,
  });
  const { data: allowed } = useHasPermissions(launch.permissions);
  return { href: launch.href, allowed: allowed === true };
}

function ChatMenuItem({
  link,
  disabled,
  children,
}: {
  link: ChatLink;
  disabled?: boolean;
  children: ReactNode;
}) {
  if (!link.href || !link.allowed || disabled)
    return <DropdownMenuItem disabled>{children}</DropdownMenuItem>;
  return (
    <DropdownMenuItem asChild>
      <Link href={link.href}>{children}</Link>
    </DropdownMenuItem>
  );
}

// ===========================================================================
// Pieces
// ===========================================================================

function EmptySuite() {
  const { busy } = useValidation();
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed px-6 py-14 text-center">
      <CircleDashed className="size-6 text-muted-foreground" aria-hidden />
      <p className="mt-3 text-sm font-medium">No validations yet</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        A validation replays a list of tool calls against your policy and checks
        each decision. Ask the agent to write one for a case you want to
        protect.
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <OpenAppaChatButton
          size="sm"
          promptKey="writeValidations"
          permissions={{ guardrailsPolicy: ["read", "update"] }}
          disabled={busy}
        >
          <MessageCircle />
          <span>Write a validation</span>
        </OpenAppaChatButton>
        <OpenAppaChatButton
          size="sm"
          variant="outline"
          promptKey="explainValidations"
          disabled={busy}
        >
          <Info />
          <span>Explain validations</span>
        </OpenAppaChatButton>
      </div>
    </div>
  );
}

function StatusGlyph({
  status,
  className,
}: {
  status: FileStatus | "running";
  className?: string;
}) {
  if (status === "running")
    return (
      <Loader2
        aria-hidden
        className={cn("animate-spin text-muted-foreground", className)}
      />
    );
  const Icon = GLYPH[status];
  return <Icon aria-hidden className={cn(GLYPH_COLOR[status], className)} />;
}

// ===========================================================================
// Data
// ===========================================================================

type FileStatus = "passed" | "failed" | "cannot_run" | "not_run";
type Step = PolicyTestRun["files"][number]["steps"][number];
type Row = {
  path: string;
  name: string;
  status: FileStatus;
  runAt: string | null;
  /** One digested line: the first `Why` reason, else the step mismatch, else the headline. */
  reason: string | null;
  /** Every reason, for the hover title. */
  reasonFull: string | null;
  line: number | null;
  /** The newest run that included this file. */
  runId: string | null;
};

function useRows(): Row[] {
  const suite = useValidation();
  const runs = suite.history.data;
  return useMemo(() => {
    const states = runs ? validationFileStates(suite.files, runs) : null;
    return suite.files.map((file): Row => {
      const state = states?.get(file.path);
      let runId: string | null = null;
      let failedStep: Step | null = null;
      for (const run of runs ?? []) {
        const result = run.files.find((item) => item.path === file.path);
        if (!result) continue;
        runId = run.id;
        failedStep =
          result.steps.find((step) => step.status !== "passed") ?? null;
        break;
      }
      const status: FileStatus = state?.status ?? "not_run";
      const inspection =
        suite.summaries?.find((item) => item.path === file.path)?.error ?? null;
      const error =
        status === "failed" || status === "cannot_run"
          ? state?.error || inspection
          : inspection;
      const step = status === "failed" ? failedStep : null;
      const why = withStepReasons(
        step?.error ? digest(step.error) : error ? digest(error) : null,
        step?.reasons,
      );
      const mismatch = step
        ? `Expected ${step.expected}, got ${step.actual ?? "no decision"}`
        : null;
      const reason = why?.reasons[0]
        ? `${why.reasons[0]}${why.reasons.length > 1 ? ` (+${why.reasons.length - 1} more)` : ""}`
        : (mismatch ?? why?.headline ?? null);
      return {
        path: file.path,
        name: validationName(file),
        status,
        runAt: state?.runAt ?? null,
        reason,
        reasonFull: [mismatch, ...(why?.reasons ?? [])]
          .filter(Boolean)
          .join("\n"),
        line: step?.line ?? null,
        runId,
      };
    });
  }, [suite.files, runs, suite.summaries]);
}

/**
 * The engine's failure text is written for agents. Keep the headline and the
 * `Why:` bullets; drop the Continue/Alternative instructions.
 */
function digest(raw: string) {
  const lines = raw.split("\n");
  let headline = "";
  const reasons: string[] = [];
  let inWhy = false;
  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    if (/^why:?$/i.test(text)) {
      inWhy = true;
      continue;
    }
    if (/^[A-Z][\w -]*:$/.test(text)) {
      if (inWhy || headline) break;
      continue;
    }
    if (inWhy) {
      const bullet = /^[-*•]\s+(.*)$/.exec(text);
      if (bullet) reasons.push(capitalize(bullet[1]));
      else if (reasons.length) reasons[reasons.length - 1] += ` ${text}`;
      continue;
    }
    if (!headline) headline = text.replace(/^\[appa\]\s*/i, "");
  }
  return { headline: headline || raw.trim(), reasons };
}

function capitalize(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

const STATUS_ORDER: Record<FileStatus, number> = {
  failed: 0,
  cannot_run: 1,
  not_run: 2,
  passed: 3,
};

const STRIP: { status: FileStatus; label: string }[] = [
  { status: "passed", label: "passing" },
  { status: "failed", label: "failing" },
  { status: "cannot_run", label: "cannot run" },
  { status: "not_run", label: "not run" },
];

const EMPTY_FILTER: Record<FileStatus, string> = {
  passed: "No validation is passing.",
  failed: "Nothing is failing.",
  cannot_run: "Every validation can run.",
  not_run: "Every validation has run.",
};

const GLYPH = {
  passed: CircleCheck,
  failed: CircleX,
  cannot_run: CircleAlert,
  not_run: CircleDashed,
} as const;

const GLYPH_COLOR: Record<FileStatus, string> = {
  passed: "text-green-600 dark:text-green-400",
  failed: "text-red-600 dark:text-red-400",
  cannot_run: "text-yellow-600 dark:text-yellow-400",
  not_run: "text-muted-foreground/60",
};

const REASON_TONE: Record<FileStatus, string> = {
  passed: "text-muted-foreground",
  failed: "text-red-700/90 dark:text-red-400/90",
  cannot_run: "text-yellow-800/90 dark:text-yellow-300/90",
  not_run: "text-yellow-800/90 dark:text-yellow-300/90",
};

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
