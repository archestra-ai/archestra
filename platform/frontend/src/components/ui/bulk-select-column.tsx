"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Checkbox } from "@/components/ui/checkbox";
import { DATA_TABLE_SELECT_COLUMN_SIZE } from "@/components/ui/data-table.constants";

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
  canSelect,
}: {
  /** Names the row for screen readers, e.g. `(agent) => `Select ${agent.name}``. */
  rowLabel: (row: T) => string;
  allLabel?: string;
  /**
   * Rows the bulk actions cannot apply to — the synthetic Default environment,
   * your own membership. They render no checkbox at all rather than a disabled
   * one: there is nothing the user could do to make it tick.
   *
   * This hides the control; it does not fence the selection. "Select all on
   * this page" is a table-level toggle and will still mark these rows, so the
   * caller must filter them out of the set it acts on — which it has to do
   * anyway for ids left behind by another page.
   */
  canSelect?: (row: T) => boolean;
}): ColumnDef<T> {
  return {
    id: "select",
    size: DATA_TABLE_SELECT_COLUMN_SIZE,
    minSize: DATA_TABLE_SELECT_COLUMN_SIZE,
    maxSize: DATA_TABLE_SELECT_COLUMN_SIZE,
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
    cell: ({ row }) =>
      canSelect && !canSelect(row.original) ? null : (
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(!!value)}
          onClick={(event) => event.stopPropagation()}
          aria-label={rowLabel(row.original)}
        />
      ),
  };
}
