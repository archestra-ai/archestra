"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Checkbox } from "@/components/ui/checkbox";
import { DATA_TABLE_SELECT_COLUMN_SIZE } from "@/components/ui/data-table.constants";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getTableRangeSelection } from "@/lib/bulk-range-selection-context";

/**
 * The multiselect checkbox column, so every table that grows a bulk affordance
 * gets the same one.
 *
 * Clicks are kept off the row: most of these tables open the row on click, and
 * ticking a checkbox must not also navigate away from the selection being made.
 * Shift-click selects from the last plain-clicked row through the target in
 * the current on-screen order.
 */
export function createSelectColumn<T>({
  rowLabel,
  allLabel = "Select all on this page",
  canSelect,
  disabledReason,
}: {
  /** Names the row for screen readers, e.g. `(agent) => `Select ${agent.name}``. */
  rowLabel: (row: T) => string;
  allLabel?: string;
  /**
   * Rows the bulk actions cannot apply to. They keep a disabled checkbox in the
   * column so the table stays visually consistent and explain why on hover.
   */
  canSelect?: (row: T) => boolean;
  /** Concise explanation shown for a row that cannot be selected. */
  disabledReason?: (row: T) => string;
}): ColumnDef<T> {
  return {
    id: "select",
    size: DATA_TABLE_SELECT_COLUMN_SIZE,
    minSize: DATA_TABLE_SELECT_COLUMN_SIZE,
    maxSize: DATA_TABLE_SELECT_COLUMN_SIZE,
    enableSorting: false,
    header: ({ table }) => {
      const selectableRows = table
        .getRowModel()
        .rows.filter((row) => canSelect?.(row.original) ?? true);
      const selectedCount = selectableRows.filter((row) =>
        row.getIsSelected(),
      ).length;
      const allSelected =
        selectableRows.length > 0 && selectedCount === selectableRows.length;
      const someSelected = selectedCount > 0 && !allSelected;

      return (
        <Checkbox
          checked={allSelected || (someSelected && "indeterminate")}
          onCheckedChange={(value) => {
            table.setRowSelection((current) => {
              const next = { ...current };
              for (const row of selectableRows) {
                if (value) next[row.id] = true;
                else delete next[row.id];
              }
              return next;
            });
          }}
          onClick={(event) => event.stopPropagation()}
          aria-label={allLabel}
          disabled={selectableRows.length === 0}
        />
      );
    },
    cell: ({ row, table }) => {
      const selectable = canSelect?.(row.original) ?? true;
      const checkbox = (
        <Checkbox
          className={!selectable ? "pointer-events-none" : undefined}
          checked={selectable && row.getIsSelected()}
          onClick={(event) => {
            event.stopPropagation();
            if (!selectable) return;
            event.preventDefault();
            const orderedIds = table
              .getRowModel()
              .rows.filter(
                (candidate) => canSelect?.(candidate.original) ?? true,
              )
              .map((candidate) => candidate.id);
            const controller = getTableRangeSelection(table);
            table.setRowSelection((current) =>
              controller.update({
                current,
                orderedIds,
                targetId: row.id,
                range: event.shiftKey,
              }),
            );
          }}
          aria-label={rowLabel(row.original)}
          disabled={!selectable}
        />
      );

      if (selectable) return checkbox;
      const reason =
        disabledReason?.(row.original) ?? "Unavailable for bulk actions";

      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex cursor-not-allowed" title={reason}>
              {checkbox}
            </span>
          </TooltipTrigger>
          <TooltipContent>{reason}</TooltipContent>
        </Tooltip>
      );
    },
  };
}
