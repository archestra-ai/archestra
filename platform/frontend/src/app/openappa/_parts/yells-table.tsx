"use client";

import type { ColumnDef } from "@tanstack/react-table";
import {
  Activity,
  Check,
  FileArchive,
  Megaphone,
  MessageCircle,
  MessagesSquare,
  RotateCcw,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { CreatedByCell } from "@/components/created-by-cell";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterSearchClass,
} from "@/components/filter-bar";
import { QueryLoadError } from "@/components/query-load-error";
import { SearchInput } from "@/components/search-input";
import { TableRowActions } from "@/components/table-row-actions";
import { DataTable } from "@/components/ui/data-table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TruncatedTooltip } from "@/components/ui/truncated-tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useCursorPagination } from "@/lib/hooks/use-cursor-pagination";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useIsMobile } from "@/lib/hooks/use-mobile";
import { llmSessionHref } from "@/lib/interactions/llm-log-links";
import {
  type OpenAppaYell,
  useOpenAppaYellArchive,
  useOpenAppaYells,
  useResolveOpenAppaYell,
} from "@/lib/openappa-yells.query";
import {
  formatCompactRelativeTime,
  formatDate,
  formatRelativeTimeFromNow,
} from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import { useYellInvestigation } from "./use-yell-investigation";

export function YellsTable() {
  const [search, setSearch] = useState("");
  const { searchParams, updateQueryParams } = useDataTableQueryParams();
  const status =
    searchParams.get("status") === "resolved" ? "resolved" : "unresolved";
  const pagination = useCursorPagination();
  const isMobile = useIsMobile();
  const { data: canRead, isPending: permissionsLoading } = useHasPermissions({
    log: ["read"],
  });
  const { data: canResolve } = useHasPermissions({
    log: ["read"],
  });
  const yells = useOpenAppaYells(
    {
      search: search || undefined,
      status,
      cursor: pagination.cursor,
      limit: pagination.pageSize,
    },
    !!canRead,
  );
  const resolve = useResolveOpenAppaYell();
  const clearFilters = () => {
    setSearch("");
    updateQueryParams({ status: null });
    pagination.goNewest();
  };
  const actionsColumn: ColumnDef<OpenAppaYell> = {
    id: "actions",
    header: "Actions",
    size: 96,
    cell: ({ row }) => (
      <YellRowActions
        yell={row.original}
        canResolve={!!canResolve}
        pending={resolve.isPending}
        onResolve={() =>
          resolve.mutate({
            id: row.original.id,
            resolved: !row.original.resolvedAt,
          })
        }
      />
    ),
  };
  const columns: ColumnDef<OpenAppaYell>[] = isMobile
    ? [
        {
          id: "message",
          header: "Yell",
          size: 200,
          cell: ({ row }) => {
            const yell = row.original;
            return (
              <SuperyellEdge yell={yell} className="min-w-0 space-y-1">
                <div className="flex min-w-0 items-center gap-2">
                  <Faded yell={yell} className="flex shrink-0">
                    <KindDot yell={yell} />
                  </Faded>
                  <MessageLine yell={yell} />
                </div>
                <div className="flex min-w-0 items-center gap-1.5 pl-4 text-xs text-muted-foreground">
                  <Faded
                    yell={yell}
                    className="flex min-w-0 items-center gap-1.5"
                  >
                    <time
                      dateTime={yell.createdAt}
                      className="shrink-0 font-mono tabular-nums"
                    >
                      {formatCompactRelativeTime(yell.createdAt)}
                    </time>
                    <span aria-hidden="true">·</span>
                    <YellCaller yell={yell} />
                  </Faded>
                  <YellSignals yell={yell} />
                </div>
              </SuperyellEdge>
            );
          },
        },
        actionsColumn,
      ]
    : [
        {
          id: "time",
          header: "Time",
          size: 132,
          cell: ({ row }) => <TimeCell yell={row.original} />,
        },
        {
          id: "message",
          header: "Report",
          size: 380,
          cell: ({ row }) => <MessageLine yell={row.original} />,
        },
        {
          id: "caller",
          header: "Reported by",
          size: 220,
          cell: ({ row }) => (
            <Faded yell={row.original} className="text-[13px]">
              <YellCaller yell={row.original} />
            </Faded>
          ),
        },
        {
          id: "signals",
          header: "Signals",
          size: 96,
          cell: ({ row }) => <YellSignals yell={row.original} />,
        },
        actionsColumn,
      ];
  if (!permissionsLoading && !canRead)
    return (
      <p className="text-sm text-muted-foreground">
        You do not have permission to view yells.
      </p>
    );
  return (
    <div className="space-y-4">
      <CollectionFilters>
        <FilterBar
          search={
            <SearchInput
              value={search}
              syncQueryParams={false}
              placeholder="Search reports"
              className={filterSearchClass}
              isLoading={yells.isFetching}
              onSearchChange={(value) => {
                setSearch(value);
                pagination.goNewest();
              }}
            />
          }
          onClearFilters={
            search || status === "resolved" ? clearFilters : undefined
          }
        >
          <FilterSelect
            value={status}
            inactiveValue="unresolved"
            ariaLabel="Yell status"
            placeholder="Status"
            showSearch={false}
            items={[
              { value: "unresolved", label: "Unresolved" },
              { value: "resolved", label: "Resolved" },
            ]}
            onValueChange={(value) => {
              updateQueryParams({
                status: value === "resolved" ? value : null,
              });
              pagination.goNewest();
            }}
          />
        </FilterBar>
      </CollectionFilters>
      {yells.isError ? (
        <QueryLoadError
          title="Could not load yells"
          error={yells.error}
          onRetry={() => yells.refetch()}
        />
      ) : (
        <DataTable
          columns={columns}
          fixedWidthColumnIds={["time", "caller", "signals"]}
          flexibleColumnIds={["message"]}
          data={yells.data?.data ?? []}
          getRowId={(row) => row.id}
          isLoading={permissionsLoading || yells.isFetching}
          manualPagination
          cursorPagination={{
            pageIndex: pagination.pageIndex,
            pageSize: pagination.pageSize,
            canGoNewer: pagination.canGoNewer,
            hasNext: yells.data?.pagination.hasNext ?? false,
            onPageSizeChange: pagination.setPageSize,
            onNewer: pagination.goNewer,
            onOlder: () =>
              pagination.goOlder(yells.data?.pagination.nextCursor ?? null),
          }}
          emptyIcon={Megaphone}
          emptyMessage="No unresolved yells"
          emptyDescription="Reports appear here when an agent uses the yell tool."
          hasActiveFilters={!!search || status === "resolved"}
          filteredEmptyMessage="No reports match these filters."
          onClearFilters={clearFilters}
        />
      )}
    </div>
  );
}

function YellRowActions({
  yell,
  canResolve,
  pending,
  onResolve,
}: {
  yell: OpenAppaYell;
  canResolve: boolean;
  pending: boolean;
  onResolve: () => void;
}) {
  const investigation = useYellInvestigation({
    id: yell.id,
    hasArchive: yell.hasArchive,
    conversationId: yell.conversation?.id ?? null,
  });
  return (
    <TableRowActions
      actions={[
        {
          icon: <MessageCircle className="size-4" />,
          label: investigation.label,
          permissions: investigation.permissions,
          disabled: investigation.disabled,
          onClick: investigation.launch,
        },
        ...(canResolve
          ? [
              {
                icon: yell.resolvedAt ? (
                  <RotateCcw className="size-4" />
                ) : (
                  <Check className="size-4" />
                ),
                label: yell.resolvedAt ? "Reopen" : "Mark resolved",
                disabled: pending,
                onClick: onResolve,
              },
            ]
          : []),
      ]}
    />
  );
}

/**
 * What the yell left behind, each one a shortcut: its report to download,
 * its investigation chat, its place in the session trace. Only the ones it
 * has, packed together.
 */
function YellSignals({ yell }: { yell: OpenAppaYell }) {
  const archive = useOpenAppaYellArchive();
  const traceHref = useYellTraceHref(yell);
  const signals: {
    key: string;
    label: string;
    icon: ReactNode;
    href?: string;
    onClick?: () => void;
  }[] = [];
  if (yell.hasArchive)
    signals.push({
      key: "report",
      label: "Download report",
      icon: <FileArchive />,
      onClick: () => archive.mutate({ id: yell.id, download: true }),
    });
  if (yell.conversation)
    signals.push({
      key: "chat",
      label: "Open the investigation chat",
      icon: <MessagesSquare />,
      href: `/chat/${yell.conversation.id}`,
    });
  if (traceHref)
    signals.push({
      key: "trace",
      label: "View in the session trace",
      icon: <Activity />,
      href: traceHref,
    });
  if (signals.length === 0) return null;
  const className =
    "inline-flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-3.5";
  return (
    <div className="-ml-1 flex shrink-0 items-center">
      {signals.map((signal) => (
        <Tooltip key={signal.key}>
          <TooltipTrigger asChild>
            {signal.href ? (
              <Link
                href={signal.href}
                aria-label={signal.label}
                className={className}
              >
                {signal.icon}
              </Link>
            ) : (
              <UnstyledButton
                aria-label={signal.label}
                onClick={signal.onClick}
                disabled={archive.isPending}
                className={className}
              >
                {signal.icon}
              </UnstyledButton>
            )}
          </TooltipTrigger>
          <TooltipContent>{signal.label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

/**
 * The yell's session trace, opened on its `yell` call. Only for a session
 * whose requests were logged, and that the viewer may read: their own, or
 * anyone's with `log:admin`.
 */
function useYellTraceHref(yell: OpenAppaYell): string | null {
  const { data: session } = useSession();
  const { data: canReadAllLogs } = useHasPermissions({ log: ["admin"] });
  const { trace } = yell;
  if (!trace) return null;
  const own = session?.user.id && yell.callerId === `user:${session.user.id}`;
  if (!own && !canReadAllLogs) return null;
  return llmSessionHref(
    trace.llmSessionId,
    trace.mcpToolCallId ? { toolCall: trace.mcpToolCallId } : undefined,
  );
}

function YellCaller({ yell }: { yell: OpenAppaYell }) {
  if (yell.caller)
    return (
      <CreatedByCell createdBy={yell.caller} showServiceAccountBadge={false} />
    );
  const label = yell.callerId.startsWith("user:service-account:")
    ? "Unknown service account"
    : yell.callerId.startsWith("user:")
      ? "Unknown user"
      : yell.callerId.startsWith("app:")
        ? "App"
        : yell.callerId.startsWith("virtual-key:")
          ? "Virtual key"
          : "Unattributed caller";
  return <span className="text-xs text-muted-foreground">{label}</span>;
}

const SUPERYELL_HINT =
  "Broke the glass: guardrails turned off for this session";

/**
 * Kind dot, clock time and age. One tooltip names the kind and the exact
 * time; an open superyell gets a rose edge on the row's leading border.
 */
function TimeCell({ yell }: { yell: OpenAppaYell }) {
  return (
    <SuperyellEdge yell={yell} className="flex items-center whitespace-nowrap">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex cursor-default items-center">
            <Faded yell={yell} className="flex items-center gap-2.5">
              <KindDot yell={yell} />
              <span className="flex items-baseline gap-2">
                <time
                  dateTime={yell.createdAt}
                  className="font-mono text-[13px] tabular-nums text-foreground"
                >
                  {formatDate({ date: yell.createdAt, dateFormat: "HH:mm" })}
                </time>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {formatCompactRelativeTime(yell.createdAt)}
                </span>
              </span>
            </Faded>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">
          <span className="block space-y-0.5 text-left">
            <span className="block font-medium">
              {yell.superyell ? "Superyell" : "Yell"}
              {yell.resolvedAt && (
                <span className="font-normal opacity-70">
                  {" "}
                  · Resolved {formatRelativeTimeFromNow(yell.resolvedAt)}
                </span>
              )}
            </span>
            {yell.superyell && <span className="block">{SUPERYELL_HINT}</span>}
            <span className="block font-mono text-[11px] tabular-nums opacity-70">
              {formatDate({
                date: yell.createdAt,
                dateFormat: "MMM d, yyyy HH:mm:ss",
              })}
            </span>
          </span>
        </TooltipContent>
      </Tooltip>
    </SuperyellEdge>
  );
}

/**
 * Amber for a yell, rose with a halo for a superyell. A resolved yell keeps
 * its colour but hollows out, so its kind still reads once it is done.
 */
function KindDot({ yell }: { yell: OpenAppaYell }) {
  return (
    <span
      className={cn(
        "size-2 shrink-0 rounded-full",
        yell.resolvedAt
          ? yell.superyell
            ? "border-[1.5px] border-rose-500/70 dark:border-rose-400/70"
            : "border-[1.5px] border-amber-500/70 dark:border-amber-400/70"
          : yell.superyell
            ? "bg-rose-500 ring-[3px] ring-rose-500/20 dark:bg-rose-400 dark:ring-rose-400/20"
            : "bg-amber-500 dark:bg-amber-400",
      )}
    >
      <span className="sr-only">
        {yell.superyell ? `Superyell: ${SUPERYELL_HINT}` : "Yell"}
      </span>
    </span>
  );
}

/** The message on one line; the whole text, paragraphs kept, on hover. */
function MessageLine({ yell }: { yell: OpenAppaYell }) {
  return (
    <Faded yell={yell} className="flex min-w-0 flex-1">
      <TruncatedTooltip
        content={
          <span className="block max-h-80 max-w-md overflow-y-auto whitespace-pre-wrap break-words text-left text-[13px] leading-relaxed">
            {yell.message.trim()}
          </span>
        }
      >
        <p className="min-w-0 flex-1 truncate text-[13px]">
          {yell.message.replace(/\s+/g, " ").trim()}
        </p>
      </TruncatedTooltip>
    </Faded>
  );
}

/** The rose edge an open superyell paints on its row's leading border. */
function SuperyellEdge({
  yell,
  className,
  children,
}: {
  yell: OpenAppaYell;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative",
        yell.superyell &&
          !yell.resolvedAt &&
          "before:absolute before:-inset-y-2 before:-left-4 before:w-0.5 before:bg-rose-500 dark:before:bg-rose-400",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A resolved yell reads as done: all but its shortcuts recede. */
function Faded({
  yell,
  className,
  children,
}: {
  yell: OpenAppaYell;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("min-w-0", yell.resolvedAt && "opacity-60", className)}>
      {children}
    </div>
  );
}
