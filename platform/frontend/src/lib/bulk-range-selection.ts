import type { RowSelectionState } from "@tanstack/react-table";

/**
 * One range-selection state machine shared by table rows and cards.
 * The clicked endpoint's next state selects or deselects the whole visible
 * range, and every interaction advances the anchor to that endpoint.
 */
export class BulkRangeSelectionController {
  private anchorId: string | null = null;

  update({
    current,
    orderedIds,
    targetId,
    range,
  }: {
    current: RowSelectionState;
    orderedIds: readonly string[];
    targetId: string;
    range: boolean;
  }): RowSelectionState {
    const selected = !current[targetId];
    let affectedIds: readonly string[] = [targetId];

    if (range) {
      const anchorIndex = orderedIds.indexOf(this.anchorId ?? "");
      const targetIndex = orderedIds.indexOf(targetId);
      if (anchorIndex !== -1 && targetIndex !== -1) {
        const [from, to] =
          anchorIndex < targetIndex
            ? [anchorIndex, targetIndex]
            : [targetIndex, anchorIndex];
        affectedIds = orderedIds.slice(from, to + 1);
      }
    }

    this.anchorId = targetId;
    return updateSelection(current, affectedIds, selected);
  }

  set({
    current,
    targetId,
    selected,
  }: {
    current: RowSelectionState;
    targetId: string;
    selected: boolean;
  }): RowSelectionState {
    return updateSelection(current, [targetId], selected);
  }
}

function updateSelection(
  current: RowSelectionState,
  ids: readonly string[],
  selected: boolean,
): RowSelectionState {
  const next = { ...current };
  for (const id of ids) {
    if (selected) next[id] = true;
    else delete next[id];
  }
  return next;
}
