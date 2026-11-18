"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Megaphone } from "lucide-react";
import type { ReactNode } from "react";
import {
  YellCaller,
  YellFaded,
  YellGuardrailsMark,
  YellRowActions,
} from "@/app/openappa/_parts/yell-row";
import { yellSummary } from "@/app/openappa/_parts/yell-summary";
import type { OpenAppaYell } from "@/lib/openappa-yells.query";
import {
  formatCompactRelativeTime,
  formatDate,
  formatRelativeTimeFromNow,
} from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import { buildConsultColumns } from "./consult-columns";
import type { ConsultView } from "./consult-details";

/** One row of the Guardrails log: a consult of an external service, or a yell. */
export type GuardrailLogRow =
  | { kind: "consult"; id: string; view: ConsultView }
  | { kind: "yell"; id: string; yell: OpenAppaYell };

/**
 * The Guardrails log's columns. A consult keeps the cells of the consults
 * table; a yell fills the same columns with what it has: who reported it,
 * the report, whether it is resolved, and its actions.
 */
export function buildGuardrailLogColumns(params: {
  /** The slowest consult on the page, which scales the latency bars. */
  maxMs: number;
  canResolve: boolean;
  resolving: boolean;
  onResolve: (yell: OpenAppaYell) => void;
}): ColumnDef<GuardrailLogRow>[] {
  const consultColumns = buildConsultColumns(params.maxMs);
  const columns = consultColumns.map((column) => {
    const definition: ColumnDef<GuardrailLogRow> = {
      id: column.id ?? "",
      size: column.size,
      minSize: column.minSize,
      header: HEADERS[column.id ?? ""] ?? String(column.header),
      cell: ({ row }) => {
        const entry = row.original;
        if (entry.kind === "yell")
          return <YellCell column={column.id ?? ""} yell={entry.yell} />;
        // The consult's own cell reads nothing but its row.
        const cell = column.cell as (context: {
          row: { original: ConsultView };
        }) => ReactNode;
        return cell({ row: { original: entry.view } });
      },
    };
    return definition;
  });
  return [
    ...columns,
    {
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      size: 128,
      cell: ({ row }) => {
        const entry = row.original;
        if (entry.kind !== "yell") return null;
        return (
          <YellRowActions
            compact
            yell={entry.yell}
            canResolve={params.canResolve}
            pending={params.resolving}
            onResolve={() => params.onResolve(entry.yell)}
          />
        );
      },
    },
  ];
}

// === Internal helpers ===

const HEADERS: Record<string, string | (() => ReactNode)> = {
  service: "Source",
  tool: "Detail",
  latency: () => <div className="text-right">Latency</div>,
  time: () => <div className="text-right">Time</div>,
};

function YellCell({ column, yell }: { column: string; yell: OpenAppaYell }) {
  switch (column) {
    case "service":
      return <YellSourceCell yell={yell} />;
    case "tool":
      return (
        // The report fills the two lines a consult's cell has; the whole of
        // it is on the yell's own page.
        <YellFaded yell={yell}>
          <p className="line-clamp-2 text-[13px] leading-[18px] break-words">
            {yellSummary(yell)}
          </p>
        </YellFaded>
      );
    case "status":
      return <YellStatusCell yell={yell} />;
    case "latency":
      return (
        <div
          className="text-right text-sm text-muted-foreground"
          title="A yell has no latency"
        >
          —
        </div>
      );
    case "time":
      return (
        <YellFaded yell={yell} className="ml-auto text-right tabular-nums">
          <time dateTime={yell.createdAt} className="block text-sm leading-5">
            {formatCompactRelativeTime(yell.createdAt)}
          </time>
          <span className="block text-xs leading-4 whitespace-nowrap text-muted-foreground">
            {formatDate({ date: yell.createdAt, dateFormat: "MMM d · HH:mm" })}
          </span>
        </YellFaded>
      );
    default:
      return null;
  }
}

/** A megaphone where a consult has its service tile, then who reported it. */
function YellSourceCell({ yell }: { yell: OpenAppaYell }) {
  return (
    <div className="relative flex min-w-0 items-center gap-3">
      {!yell.resolvedAt && (
        <span
          aria-hidden="true"
          className="absolute top-1/2 -left-3 h-9 w-[3px] -translate-y-1/2 rounded-full bg-amber-500"
        />
      )}
      <span
        aria-hidden="true"
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-md",
          yell.resolvedAt
            ? "bg-muted text-muted-foreground"
            : "bg-amber-500/15 text-amber-600 dark:text-amber-400",
        )}
      >
        <Megaphone className="size-4" />
      </span>
      <YellFaded yell={yell} className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm leading-5 font-medium">
          <span className="truncate">{YELL_TITLE[yell.kind]}</span>
          <YellGuardrailsMark yell={yell} />
        </div>
        <div className="flex h-4 min-w-0 items-center text-xs leading-4 text-muted-foreground [&_*]:text-xs">
          <YellCaller yell={yell} />
        </div>
      </YellFaded>
    </div>
  );
}

const YELL_TITLE: Record<OpenAppaYell["kind"], string> = {
  agent: "Yell",
  approval_waived: "Approval waived",
  block_waived: "Blocked call let through",
};

function YellStatusCell({ yell }: { yell: OpenAppaYell }) {
  return (
    <span className="block min-w-0 text-left">
      <span className="flex h-5 items-center gap-1.5 text-sm leading-5">
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            yell.resolvedAt ? "bg-muted-foreground/40" : "bg-amber-500",
          )}
        />
        <span
          className={cn(
            "truncate",
            yell.resolvedAt
              ? "text-muted-foreground"
              : "text-amber-700 dark:text-amber-400",
          )}
        >
          {yell.resolvedAt ? "Resolved" : "Unresolved"}
        </span>
      </span>
      <span className="block h-4 truncate text-xs leading-4 text-muted-foreground">
        {yell.resolvedAt
          ? formatRelativeTimeFromNow(yell.resolvedAt)
          : "Waiting for someone to look"}
      </span>
    </span>
  );
}
