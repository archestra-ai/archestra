"use client";

import type { ReasoningUIPart } from "ai";
import { createContext, useContext } from "react";

export type ReasoningContextValue = {
  state: ReasoningUIPart["state"];
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  duration: number;
};

export const ReasoningContext = createContext<ReasoningContextValue | null>(
  null,
);

export const useReasoning = () => {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error("Reasoning components must be used within Reasoning");
  }
  return context;
};
