"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { formatDate } from "@/lib/utils";
import { AuditEventTypeBadge } from "./audit-event-type-badge";
import type { AuditLogEvent } from "./audit-log.types";
import { AuditStatusBadge } from "./audit-status-badge";

export const auditLogColumns: ColumnDef<AuditLogEvent>[] = [
  {
    accessorKey: "createdAt",
    header: "Date",
    cell: ({ row }) => (
      <div className="font-mono text-xs whitespace-nowrap">
        {formatDate({ date: row.original.createdAt })}
      </div>
    ),
  },
  {
    accessorKey: "type",
    header: "Type",
    cell: ({ row }) => <AuditEventTypeBadge type={row.original.type} />,
  },
  {
    accessorKey: "actor",
    header: "Actor",
    cell: ({ row }) => (
      <div className="max-w-[220px] truncate font-medium">
        {row.original.actor}
      </div>
    ),
  },
  {
    accessorKey: "action",
    header: "Action",
    cell: ({ row }) => (
      <div className="font-mono text-xs">{row.original.action}</div>
    ),
  },
  {
    accessorKey: "target",
    header: "Target",
    cell: ({ row }) => (
      <div className="max-w-[220px] truncate">{row.original.target}</div>
    ),
  },
  {
    accessorKey: "from",
    header: "From",
    cell: ({ row }) => (
      <div className="max-w-[180px] truncate text-muted-foreground">
        {row.original.from}
      </div>
    ),
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => <AuditStatusBadge status={row.original.status} />,
  },
  {
    accessorKey: "summary",
    header: "Summary",
    cell: ({ row }) => (
      <div className="max-w-[360px] truncate text-muted-foreground">
        {row.original.summary}
      </div>
    ),
  },
];
