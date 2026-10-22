"use client";

import type { ColumnDef } from "@tanstack/react-table";
import {
  Activity,
  AppWindow,
  Bot,
  Check,
  FileArchive,
  KeyRound,
  Link2,
  Megaphone,
  MessageCircle,
  MessagesSquare,
  RotateCcw,
  ShieldOff,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { CreatedByCell } from "@/components/created-by-cell";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterSearchClass,
} from "@/components/filter-bar";
import { LogTime } from "@/components/log-time";
import { QueryLoadError } from "@/components/query-load-error";
import { SearchInput } from "@/components/search-input";
import { TableRowActions } from "@/components/table-row-actions";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { DataTable } from "@/components/ui/data-table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TruncatedTooltip } from "@/components/ui/truncated-tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { copyToClipboard } from "@/lib/clipboard";
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
import { formatDate } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import { useYellInvestigation } from "./use-yell-investigation";

export function YellsTable() {
  const [search, setSearch] = useState("");
  const { searchParams, updateQueryParams } = useDataTableQueryParams();
  const status =
    searchParams.get("status") === "resolved" ? "resolved" : "unresolved";
  const pagination = useCursorPagination();
  const isMobile = useIsMobile();
  const router = useRouter();
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
  // Status picks which list you are looking at, not a filter on it, so
  // only the search counts as clearable.
  const clearFilters = () => {
    setSearch("");
    pagination.goNewest();
  };
  const actionsColumn: ColumnDef<OpenAppaYell> = {
    id: "actions",
    header: "Actions",
    // Three actions need their own width; the caller column gives up space.
    size: 128,
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
              <div className="min-w-0 space-y-1">
                <MessageLine yell={yell} />
                <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <Faded
                    yell={yell}
                    className="flex min-w-0 items-center gap-1.5"
                  >
                    <time
                      dateTime={yell.createdAt}
                      className="shrink-0 tabular-nums"
                    >
                      {formatDate({
                        date: yell.createdAt,
                        dateFormat: "MMM d · HH:mm",
                      })}
                    </time>
                    <span aria-hidden="true">·</span>
                    <YellCaller yell={yell} />
                  </Faded>
                  <BrokeTheGlassMark yell={yell} />
                  <YellSignals yell={yell} />
                </div>
              </div>
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
          size: 188,
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
          cell: ({ row }) => (
            <YellSignals
              yell={row.original}
              empty={
                <span className="text-muted-foreground" title="No signals">
                  —
                </span>
              }
            />
          ),
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
          onClearFilters={search ? clearFilters : undefined}
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
          cursorPagination={pagination.tableState(yells.data?.pagination)}
          emptyIcon={Megaphone}
          emptyMessage={
            status === "resolved" ? "No resolved yells" : "No unresolved yells"
          }
          emptyDescription={
            status === "resolved"
              ? "Yells appear here once they are marked resolved."
              : "Reports appear here when an agent uses the yell tool."
          }
          hasActiveFilters={!!search}
          filteredEmptyMessage="No reports match these filters."
          onClearFilters={clearFilters}
          onRowClick={(yell, event) => {
            // Signals and actions inside the row act on their own.
            if ((event.target as HTMLElement).closest("a, button")) return;
            router.push(yellHref(yell.id));
          }}
        />
      )}
    </div>
  );
}

export function YellRowActions({
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
        {
          icon: <Link2 className="size-4" />,
          label: "Copy link",
          onClick: () => copyYellLink(yell.id),
        },
      ]}
    />
  );
}

/** The yell's detail page. */
export function yellHref(id: string) {
  return `/openappa/yells/${id}`;
}

async function copyYellLink(id: string) {
  try {
    await copyToClipboard(new URL(yellHref(id), window.location.origin).href);
    toast.success("Link copied");
  } catch {
    toast.error("Could not copy the link");
  }
}

/**
 * What the yell left behind, each one a shortcut: its report to download,
 * its investigation chat, its place in the session trace. Only the ones it
 * has, packed together.
 */
export function YellSignals({
  yell,
  empty = null,
}: {
  yell: OpenAppaYell;
  /** Shown when the yell left nothing behind. */
  empty?: ReactNode;
}) {
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
  if (signals.length === 0) return empty;
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

export function YellCaller({ yell }: { yell: OpenAppaYell }) {
  if (yell.caller)
    return (
      <CreatedByCell createdBy={yell.caller} showServiceAccountBadge={false} />
    );
  const { callerId, callerApp } = yell;
  const shape = callerApp
    ? ([AppWindow, callerApp.name, true] as const)
    : callerId.startsWith("app:")
      ? ([AppWindow, "Deleted app", false] as const)
      : callerId.startsWith("virtual-key:")
        ? ([KeyRound, "Virtual key", false] as const)
        : callerId.startsWith("user:service-account:")
          ? ([Bot, "Unknown service account", false] as const)
          : callerId.startsWith("user:")
            ? ([UserRound, "Unknown user", false] as const)
            : null;
  // No one to name: the same dash as an empty Signals cell.
  if (!shape)
    return (
      <span className="text-muted-foreground" title="Unattributed caller">
        —
      </span>
    );
  const [Icon, label, known] = shape;
  // The same avatar-and-name shape as a person's cell, so the column reads as
  // one list whatever kind of caller sent the yell.
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar className="h-5 w-5 shrink-0" aria-hidden="true">
        <AvatarFallback>
          <Icon className="size-3" aria-hidden="true" />
        </AvatarFallback>
      </Avatar>
      <span
        className={cn("min-w-0 truncate", !known && "text-muted-foreground")}
      >
        {label}
        {callerApp ? <span className="sr-only"> (app)</span> : null}
      </span>
    </span>
  );
}

export const BROKE_THE_GLASS_HINT =
  "Broke the glass: guardrails turned off for this session";

/** The shared log time, then a broke-the-glass mark in a fixed slot. */
function TimeCell({ yell }: { yell: OpenAppaYell }) {
  return (
    <div className="flex items-center gap-2">
      <Faded yell={yell} className="flex">
        <LogTime showTooltip={false} timestamp={yell.createdAt} />
      </Faded>
      <BrokeTheGlassMark yell={yell} />
    </div>
  );
}

/** A shield-off icon with its explanation on hover; nothing for a plain yell. */
export function BrokeTheGlassMark({ yell }: { yell: OpenAppaYell }) {
  if (!yell.superyell) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0 cursor-default text-muted-foreground">
          <ShieldOff className="size-3.5" aria-label={BROKE_THE_GLASS_HINT} />
        </span>
      </TooltipTrigger>
      <TooltipContent>{BROKE_THE_GLASS_HINT}</TooltipContent>
    </Tooltip>
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
