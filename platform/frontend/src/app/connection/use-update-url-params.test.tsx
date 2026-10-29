import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

// A selection must update the URL without navigating the Connect route.
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: () => {
      throw new Error("Unexpected navigation");
    },
  }),
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

import { useUpdateUrlParams } from "./use-update-url-params";

beforeEach(() => {
  window.history.replaceState(
    null,
    "",
    "/connection?clientId=codex&providerId=openai&connectRequest=pending#setup",
  );
});

it("switches clients without navigation while preserving approval context and the anchor", () => {
  const { result } = renderHook(() => useUpdateUrlParams());
  const length = window.history.length;
  act(() => result.current({ clientId: "claude-desktop", providerId: null }));
  expect(
    window.location.pathname + window.location.search + window.location.hash,
  ).toBe("/connection?clientId=claude-desktop&connectRequest=pending#setup");
  expect(window.history.length).toBe(length);
});

it("merges consecutive selections against the current URL before React rerenders", () => {
  const { result } = renderHook(() => useUpdateUrlParams());
  act(() => {
    result.current({ clientId: "claude-desktop", providerId: null });
    result.current({ gatewayId: "gateway" });
    result.current({ providerId: "anthropic" });
  });
  expect(
    Object.fromEntries(new URLSearchParams(window.location.search)),
  ).toEqual({
    clientId: "claude-desktop",
    connectRequest: "pending",
    gatewayId: "gateway",
    providerId: "anthropic",
  });
});
