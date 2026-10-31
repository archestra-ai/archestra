import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { useIsMobile } from "@/lib/hooks/use-mobile";
import type { ChartKind } from "./cost-explorer-data";
import { useResponsiveChart } from "./use-responsive-chart";

vi.mock("@/lib/hooks/use-mobile");

it("defaults mobile to table and restores separate explicit choices across resizes", () => {
  vi.mocked(useIsMobile).mockReturnValue(false);
  const { result, rerender } = renderHook(() => {
    const [desktop, setDesktop] = useState<ChartKind>("lines");
    const [mobile, setMobile] = useState<ChartKind>();
    return useResponsiveChart(desktop, mobile, setDesktop, setMobile);
  });
  expect(result.current[0]).toBe("lines");
  vi.mocked(useIsMobile).mockReturnValue(true);
  rerender();
  expect(result.current[0]).toBe("table");
  act(() => result.current[1]("bars"));
  expect(result.current[0]).toBe("bars");
  vi.mocked(useIsMobile).mockReturnValue(false);
  rerender();
  expect(result.current[0]).toBe("lines");
  vi.mocked(useIsMobile).mockReturnValue(true);
  rerender();
  expect(result.current[0]).toBe("bars");
});
