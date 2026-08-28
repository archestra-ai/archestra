import type { RowSelectionState } from "@tanstack/react-table";
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import {
  useBulkSelection,
  useControlledRowSelection,
} from "./use-bulk-selection";

const rows = ["one", "two", "three"].map((id) => ({ id }));

describe("useBulkSelection", () => {
  it("shows an escalated matching set and exits it from a manual change", () => {
    const { result } = renderHook(() =>
      useBulkSelection({
        rows,
        getId: (row) => row.id,
        filterSignature: "all",
      }),
    );

    act(() => {
      result.current.onPageRowIdsChange(["one", "two"]);
      result.current.setRowSelection({ one: true, two: true });
    });
    expect(result.current.pageRowIds).toEqual(["one", "two"]);
    expect(result.current.selectAllMatching.pageFullySelected).toBe(true);
    act(() => result.current.selectAllMatching.onSelectAll());

    expect(result.current.selectAllMatching.active).toBe(true);
    expect(result.current.rowSelection).toEqual({
      one: true,
      two: true,
      three: true,
    });

    act(() =>
      result.current.setRowSelection((current) => {
        const next = { ...current };
        delete next.two;
        return next;
      }),
    );

    expect(result.current.selectAllMatching.active).toBe(false);
    expect(result.current.selected.map((row) => row.id)).toEqual([
      "one",
      "three",
    ]);
  });

  it("clears a server-paginated escalation after a manual deselect", () => {
    const { result } = renderHook(() => {
      const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
      const [allMatchingSelected, setAllMatchingSelected] = useState(true);
      const { effectiveRowSelection, onRowSelectionChange } =
        useControlledRowSelection({
          rowSelection,
          setRowSelection,
          rows,
          getRowId: (row) => row.id,
          allMatchingSelected,
          clearEscalation: () => setAllMatchingSelected(false),
        });

      return {
        allMatchingSelected,
        effectiveRowSelection,
        onRowSelectionChange,
        rowSelection,
      };
    });

    expect(result.current.effectiveRowSelection).toEqual({
      one: true,
      two: true,
      three: true,
    });

    act(() => {
      result.current.onRowSelectionChange((current) => {
        const next = { ...current };
        delete next.two;
        return next;
      });
    });

    expect(result.current.allMatchingSelected).toBe(false);
    expect(result.current.rowSelection).toEqual({ one: true, three: true });
  });
});
