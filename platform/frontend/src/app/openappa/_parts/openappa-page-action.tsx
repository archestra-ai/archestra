"use client";

import { createContext, type ReactNode, useContext } from "react";
import { createPortal } from "react-dom";

export const OpenAppaPageActionSlotContext =
  createContext<HTMLDivElement | null>(null);

export function OpenAppaPageAction({ children }: { children: ReactNode }) {
  const slot = useContext(OpenAppaPageActionSlotContext);
  return slot ? createPortal(children, slot) : null;
}
