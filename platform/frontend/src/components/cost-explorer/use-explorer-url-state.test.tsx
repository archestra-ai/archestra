import { act, renderHook } from "@testing-library/react";
import { useSearchParams } from "next/navigation";
import { beforeEach, expect, it, vi } from "vitest";
import {
  decodeCostExplorer,
  EXPLORER_URL_KEYS,
  encodeCostExplorer,
} from "./explorer-url-state";
import { useExplorerUrlState } from "./use-explorer-url-state";

vi.mock("next/navigation");
beforeEach(() => {
  window.history.replaceState(
    null,
    "",
    "/llm/costs?timeframe=30d&keep=yes#chart",
  );
  vi.mocked(useSearchParams).mockImplementation(
    () =>
      new URLSearchParams(window.location.search) as ReturnType<
        typeof useSearchParams
      >,
  );
});
it("batches a drill-down into one history entry and restores shared/back states", async () => {
  const push = vi.spyOn(window.history, "pushState");
  const { result, rerender } = renderHook(() =>
    useExplorerUrlState({
      keys: EXPLORER_URL_KEYS,
      decode: decodeCostExplorer,
      encode: encodeCostExplorer,
      timeframe: "7d",
    }),
  );
  await act(async () => {
    result.current[1]("query", (previous) => ({
      ...previous,
      model: "example/model+a",
      group: "person",
    }));
    result.current[1]("view", "pivot");
  });
  expect(push).toHaveBeenCalledTimes(1);
  const shared = window.location.href;
  expect(new URL(shared).searchParams.get("model")).toBe("example/model+a");
  expect(new URL(shared).searchParams.get("timeframe")).toBe("30d");
  expect(new URL(shared).searchParams.get("keep")).toBe("yes");
  expect(new URL(shared).hash).toBe("#chart");
  act(() => {
    window.history.replaceState(null, "", "/llm/costs?timeframe=30d");
    rerender();
  });
  expect(result.current[0].query.model).toBeUndefined();
  act(() => {
    window.history.replaceState(null, "", shared);
    rerender();
  });
  expect(result.current[0].query.model).toBe("example/model+a");
  expect(result.current[0].view).toBe("pivot");
  expect(push).toHaveBeenCalledTimes(1);
});
