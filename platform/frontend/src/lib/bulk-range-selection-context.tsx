"use client";

import { createContext, type ReactNode, useContext, useRef } from "react";
import { BulkRangeSelectionController } from "./bulk-range-selection";

const BulkRangeSelectionContext =
  createContext<BulkRangeSelectionController | null>(null);
const rangeSelectionByTable = new WeakMap<
  object,
  BulkRangeSelectionController
>();

export function BulkRangeSelectionScope({ children }: { children: ReactNode }) {
  const controller = useRef(new BulkRangeSelectionController()).current;
  return (
    <BulkRangeSelectionContext.Provider value={controller}>
      {children}
    </BulkRangeSelectionContext.Provider>
  );
}

export function useBulkRangeSelectionController() {
  const scopedController = useContext(BulkRangeSelectionContext);
  const localController = useRef(new BulkRangeSelectionController()).current;
  return scopedController ?? localController;
}

export function registerTableRangeSelection({
  table,
  controller,
}: {
  table: object;
  controller: BulkRangeSelectionController;
}) {
  rangeSelectionByTable.set(table, controller);
}

export function getTableRangeSelection(table: object) {
  let controller = rangeSelectionByTable.get(table);
  if (!controller) {
    controller = new BulkRangeSelectionController();
    rangeSelectionByTable.set(table, controller);
  }
  return controller;
}
