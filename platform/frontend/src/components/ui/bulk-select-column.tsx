"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Checkbox } from "@/components/ui/checkbox";

/**
 * The multiselect checkbox column, so every table that grows a bulk affordance
 * gets the same one.
 *
 * Clicks are kept off the row: most of these tables open the row on click, and
 * ticking a checkbox must not also navigate away from the selection being made.
 */
export function createSelectColumn<T>({
  rowLabel,
  allLabel = "Select all on this page",
}: {
  /** Names the row for screen readers, e.g. `(agent) => `Select ${agent.name}``. */
  rowLabel: (row: T) => string;
  allLabel?: string;
}): ColumnDef<T> {
  return {
    id: "select",
    size: 40,
    minSize: 44,
    enableSorting: false,
    header: ({ table }) => (
      <Checkbox
        checked={
          table.getIsAllPageRowsSelected() ||
          (table.getIsSomePageRowsSelected() && "indeterminate")
        }
        onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
        onClick={(event) => event.stopPropagation()}
        aria-label={allLabel}
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        checked={row.getIsSelected()}
        onCheckedChange={(value) => row.toggleSelected(!!value)}
        onClick={(event) => event.stopPropagation()}
        aria-label={rowLabel(row.original)}
      />
    ),
  };
}
