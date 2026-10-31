"use client";

import type { SetStateAction } from "react";
import { useIsMobile } from "@/lib/hooks/use-mobile";
import type { ChartKind } from "./cost-explorer-data";

/** Mobile starts with the table; an explicit choice never replaces the desktop preference. */
export function useResponsiveChart(
  desktop: ChartKind,
  mobile: ChartKind | undefined,
  setDesktop: (value: ChartKind) => void,
  setMobile: (value: ChartKind) => void,
) {
  const isMobile = useIsMobile();
  const chart = isMobile ? (mobile ?? "table") : desktop;
  const setChart = (action: SetStateAction<ChartKind>) => {
    const value = typeof action === "function" ? action(chart) : action;
    if (isMobile) setMobile(value);
    else setDesktop(value);
  };
  return [chart, setChart] as const;
}
