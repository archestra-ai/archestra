"use client";

import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import { createPortal } from "react-dom";

export function AccountPageAction({ children }: { children: ReactNode }) {
  const slot = useContext(AccountPageActionSlotContext);
  return slot ? createPortal(children, slot) : null;
}

export const AccountPageActionSlotContext =
  createContext<HTMLDivElement | null>(null);
