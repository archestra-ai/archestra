"use client";

import type { OnChangeFn, RowSelectionState } from "@tanstack/react-table";
import { useCallback, useRef, useState } from "react";
import type { SelectAllMatching } from "@/components/ui/bulk-actions-bar";
import { BulkRangeSelectionController } from "@/lib/bulk-range-selection";

/**
 * Selection state for a table whose rows are all in memory — the client-side
 * paginated ones, where "everything that matches the filters" is simply every
 * row the caller passes in.
 *
 * It exists so those tables get the same reach-past-the-page behaviour as the
 * server-paginated ones without each repeating the same six pieces of state.
 * The server-paginated tables cannot use it: their "all matching" set has to
 * be fetched, so they own that query themselves.
 */
export function useBulkSelection<T>({
  rows,
  getId,
  canSelect,
  filterSignature,
  matchDescription,
}: {
  /** Every row matching the current filters, across pages. */
  rows: readonly T[];
  getId: (row: T) => string;
  /** Rows a bulk action can never apply to — the current session, your own membership. */
  canSelect?: (row: T) => boolean;
  /**
   * Changes whenever the filters do. An escalation is remembered as the
   * signature it was made under, so changing a filter drops it rather than
   * silently re-pointing "all 40" at a different 40.
   */
  filterSignature: string;
  /** Completes "…that {matchDescription}." */
  matchDescription?: string;
}) {
  const [storedRowSelection, setStoredRowSelection] =
    useState<RowSelectionState>({});
  const [pageRowIds, setPageRowIds] = useState<string[]>([]);
  const [escalatedFor, setEscalatedFor] = useState<string | null>(null);
  const rangeSelection = useRef(new BulkRangeSelectionController()).current;

  const clearSelection = useCallback(() => {
    setStoredRowSelection({});
    setEscalatedFor(null);
  }, []);

  // Stable so it can be handed to DataTable's onPageRowIdsChange without
  // re-subscribing every render.
  const onPageRowIdsChange = useCallback((ids: string[]) => {
    setPageRowIds((current) =>
      current.length === ids.length && current.every((id, i) => id === ids[i])
        ? current
        : ids,
    );
  }, []);

  const selectable = canSelect ? rows.filter(canSelect) : rows;
  const allMatchingSelected = escalatedFor === filterSignature;
  const allMatchingRowSelection = allMatchingSelected
    ? Object.fromEntries(selectable.map((row) => [getId(row), true]))
    : null;
  const rowSelection = allMatchingRowSelection ?? storedRowSelection;
  const setRowSelection: OnChangeFn<RowSelectionState> = (updater) => {
    setStoredRowSelection((current) => {
      const base = allMatchingRowSelection ?? current;
      return typeof updater === "function" ? updater(base) : updater;
    });
    setEscalatedFor(null);
  };

  const selected = allMatchingSelected
    ? selectable
    : selectable.filter((row) => storedRowSelection[getId(row)]);

  // Only rows that are both on screen and selectable: a page whose every
  // remaining row is unselectable is still "fully selected".
  const selectablePageIds = new Set(selectable.map(getId));
  const pageSelectableIds = pageRowIds.filter((id) =>
    selectablePageIds.has(id),
  );

  const selectAllMatching: SelectAllMatching = {
    total: selectable.length,
    pageFullySelected:
      pageSelectableIds.length > 0 &&
      pageSelectableIds.every((id) => rowSelection[id]),
    active: allMatchingSelected,
    onSelectAll: () => setEscalatedFor(filterSignature),
    matchDescription,
  };

  return {
    rowSelection,
    setRowSelection,
    onPageRowIdsChange,
    clearSelection,
    selected,
    selectAllMatching,
    rangeSelection,
    pageRowIds,
  };
}

/**
 * Gives server-paginated table and card views their effective visible-page
 * selection while an "all matching" escalation is active. Manual changes are
 * applied to that materialized page state before clearing the escalation.
 */
export function useControlledRowSelection<T>({
  rowSelection,
  setRowSelection,
  rows,
  getRowId,
  allMatchingSelected,
  clearEscalation,
  canSelect,
}: {
  rowSelection: RowSelectionState;
  setRowSelection: OnChangeFn<RowSelectionState>;
  rows: readonly T[];
  getRowId: (row: T) => string;
  allMatchingSelected: boolean;
  clearEscalation: () => void;
  canSelect?: (row: T) => boolean;
}) {
  const rangeSelection = useRef(new BulkRangeSelectionController()).current;
  const effectiveRowSelection = allMatchingSelected
    ? Object.fromEntries(
        rows
          .filter((row) => canSelect?.(row) ?? true)
          .map((row) => [getRowId(row), true]),
      )
    : rowSelection;

  const onRowSelectionChange: OnChangeFn<RowSelectionState> = useCallback(
    (updater) => {
      const next =
        typeof updater === "function"
          ? updater(effectiveRowSelection)
          : updater;
      setRowSelection(next);
      clearEscalation();
    },
    [clearEscalation, effectiveRowSelection, setRowSelection],
  );

  return { effectiveRowSelection, onRowSelectionChange, rangeSelection };
}
