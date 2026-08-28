import type { OnChangeFn, RowSelectionState } from "@tanstack/react-table";
import type { MouseEventHandler } from "react";
import type { BulkRangeSelectionController } from "@/lib/bulk-range-selection";
import { useBulkRangeSelectionController } from "@/lib/bulk-range-selection-context";

export interface BulkCardSelectionProps {
  selected: boolean;
  selectionDisabled: boolean;
  onSelectedChange: (selected: boolean) => void;
  onSelectionClick: MouseEventHandler<HTMLButtonElement>;
}

export function useBulkCardSelection<T>({
  rows,
  getRowId,
  rowSelection,
  setRowSelection,
  canSelect,
  rangeSelection: controlledRangeSelection,
}: {
  rows: readonly T[];
  getRowId: (row: T) => string;
  rowSelection: RowSelectionState;
  setRowSelection: OnChangeFn<RowSelectionState>;
  canSelect?: (row: T) => boolean;
  rangeSelection?: BulkRangeSelectionController;
}) {
  const localRangeSelection = useBulkRangeSelectionController();
  const rangeSelection = controlledRangeSelection ?? localRangeSelection;

  return (row: T): BulkCardSelectionProps => {
    const id = getRowId(row);
    const selectable = canSelect?.(row) ?? true;

    return {
      selected: !!rowSelection[id],
      selectionDisabled: !selectable,
      onSelectedChange: (selected) => {
        if (!selectable) return;
        setRowSelection((current) =>
          rangeSelection.set({ current, targetId: id, selected }),
        );
      },
      onSelectionClick: (event) => {
        event.stopPropagation();
        if (!selectable) return;
        event.preventDefault();
        const orderedIds = rows
          .filter((candidate) => canSelect?.(candidate) ?? true)
          .map(getRowId);
        setRowSelection((current) =>
          rangeSelection.update({
            current,
            orderedIds,
            targetId: id,
            range: event.shiftKey,
          }),
        );
      },
    };
  };
}
