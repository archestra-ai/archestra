import type { OnChangeFn, RowSelectionState } from "@tanstack/react-table";
import type { MouseEventHandler } from "react";
import { useRef } from "react";

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
}: {
  rows: readonly T[];
  getRowId: (row: T) => string;
  rowSelection: RowSelectionState;
  setRowSelection: OnChangeFn<RowSelectionState>;
  canSelect?: (row: T) => boolean;
}) {
  const anchorId = useRef<string | null>(null);

  return (row: T): BulkCardSelectionProps => {
    const id = getRowId(row);
    const selectable = canSelect?.(row) ?? true;

    return {
      selected: !!rowSelection[id],
      selectionDisabled: !selectable,
      onSelectedChange: (selected) => {
        if (!selectable) return;
        setRowSelection((current) => updateSelection(current, [id], selected));
      },
      onSelectionClick: (event) => {
        event.stopPropagation();
        if (!selectable) return;
        if (!event.shiftKey) {
          anchorId.current = id;
          return;
        }

        const selectableIds = rows
          .filter((candidate) => canSelect?.(candidate) ?? true)
          .map(getRowId);
        const anchorIndex = selectableIds.indexOf(anchorId.current ?? "");
        const targetIndex = selectableIds.indexOf(id);
        anchorId.current = id;

        if (
          anchorIndex === -1 ||
          targetIndex === -1 ||
          anchorIndex === targetIndex
        ) {
          return;
        }

        event.preventDefault();
        const selected = !rowSelection[id];
        const [from, to] =
          anchorIndex < targetIndex
            ? [anchorIndex, targetIndex]
            : [targetIndex, anchorIndex];
        setRowSelection((current) =>
          updateSelection(current, selectableIds.slice(from, to + 1), selected),
        );
      },
    };
  };
}

function updateSelection(
  current: RowSelectionState,
  ids: readonly string[],
  selected: boolean,
) {
  const next = { ...current };
  for (const id of ids) {
    if (selected) next[id] = true;
    else delete next[id];
  }
  return next;
}
