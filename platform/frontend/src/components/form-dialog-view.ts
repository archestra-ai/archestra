"use client";

import { createContext, useContext } from "react";

/** Secondary tasks stay inside the current dialog while its form stays mounted. */
export const FormDialogViewContext = createContext<{
  setView: (view: { title: string; description: string } | null) => void;
  setDirty: (dirty: boolean) => void;
  body: HTMLElement | null;
  footer: HTMLElement | null;
} | null>(null);

export function useFormDialogView() {
  return useContext(FormDialogViewContext);
}
