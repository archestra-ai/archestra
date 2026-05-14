import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_LOG_QUERY_KEY } from "./audit-log.query";
import { useAuditLogWebsocket } from "./audit-log-websocket.hook";

/**
 * Contract: useAuditLogWebsocket — invalidate list on page-1 live feed, buffer
 * counts when filtered or paginated, unsubscribe on unmount, optional enabled gate.
 */

// Capture the subscribe callback so each test can drive the hook by firing a
// "fake" audit_log message directly into it.
let lastAuditHandler:
  | ((message: { type: "audit_log"; data: unknown }) => void)
  | null = null;
const unsubscribeSpy = vi.fn();
const connectSpy = vi.fn();
const subscribeSpy = vi.fn(
  (type: string, handler: (message: unknown) => void) => {
    if (type === "audit_log") {
      lastAuditHandler = handler as typeof lastAuditHandler;
    }
    return unsubscribeSpy;
  },
);

vi.mock("@/lib/websocket/websocket", () => ({
  default: {
    connect: (...args: unknown[]) => connectSpy(...args),
    subscribe: (type: string, handler: (m: unknown) => void) =>
      subscribeSpy(type, handler),
  },
}));

function makeWrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function fireAuditMessage() {
  if (!lastAuditHandler) throw new Error("audit handler not subscribed");
  act(() => {
    lastAuditHandler?.({ type: "audit_log", data: { id: "evt-1" } } as never);
  });
}

describe("useAuditLogWebsocket", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastAuditHandler = null;
  });

  it("subscribes to audit_log messages and connects on mount", () => {
    const queryClient = new QueryClient();
    renderHook(
      () =>
        useAuditLogWebsocket({
          isFirstPage: true,
          hasStartDateFilter: false,
        }),
      { wrapper: makeWrapper(queryClient) },
    );

    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(subscribeSpy).toHaveBeenCalledWith(
      "audit_log",
      expect.any(Function),
    );
  });

  it("invalidates the audit-log query on page 1 with no startDate filter", () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(
      () =>
        useAuditLogWebsocket({
          isFirstPage: true,
          hasStartDateFilter: false,
        }),
      { wrapper: makeWrapper(queryClient) },
    );

    fireAuditMessage();

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: AUDIT_LOG_QUERY_KEY,
    });
    expect(result.current.newEventCount).toBe(0);
  });

  it("does not invalidate when the user is past page 1 — increments newEventCount instead", () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(
      () =>
        useAuditLogWebsocket({
          isFirstPage: false,
          hasStartDateFilter: false,
        }),
      { wrapper: makeWrapper(queryClient) },
    );

    fireAuditMessage();
    fireAuditMessage();

    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(result.current.newEventCount).toBe(2);
  });

  it("does not invalidate when a startDate filter is active — increments newEventCount", () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(
      () =>
        useAuditLogWebsocket({
          isFirstPage: true,
          hasStartDateFilter: true,
        }),
      { wrapper: makeWrapper(queryClient) },
    );

    fireAuditMessage();
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(result.current.newEventCount).toBe(1);
  });

  it("reads the latest isFirstPage / hasStartDateFilter from refs without resubscribing", () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result, rerender } = renderHook(
      ({
        isFirstPage,
        hasStartDateFilter,
      }: {
        isFirstPage: boolean;
        hasStartDateFilter: boolean;
      }) => useAuditLogWebsocket({ isFirstPage, hasStartDateFilter }),
      {
        wrapper: makeWrapper(queryClient),
        initialProps: { isFirstPage: false, hasStartDateFilter: false },
      },
    );

    fireAuditMessage();
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(result.current.newEventCount).toBe(1);

    // Switch to page 1, no filter — next event should now invalidate
    rerender({ isFirstPage: true, hasStartDateFilter: false });

    // Subscribe must NOT have been called again — same handler from the original mount
    expect(subscribeSpy).toHaveBeenCalledTimes(1);

    fireAuditMessage();
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  it("resetNewEventCount clears the buffered counter", () => {
    const queryClient = new QueryClient();
    const { result } = renderHook(
      () =>
        useAuditLogWebsocket({
          isFirstPage: false,
          hasStartDateFilter: false,
        }),
      { wrapper: makeWrapper(queryClient) },
    );

    fireAuditMessage();
    fireAuditMessage();
    fireAuditMessage();
    expect(result.current.newEventCount).toBe(3);

    act(() => {
      result.current.resetNewEventCount();
    });

    expect(result.current.newEventCount).toBe(0);
  });

  it("unsubscribes from the websocket on unmount", () => {
    const queryClient = new QueryClient();
    const { unmount } = renderHook(
      () =>
        useAuditLogWebsocket({
          isFirstPage: true,
          hasStartDateFilter: false,
        }),
      { wrapper: makeWrapper(queryClient) },
    );

    unmount();
    expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
  });

  it("does nothing when enabled=false", () => {
    const queryClient = new QueryClient();

    renderHook(
      () =>
        useAuditLogWebsocket({
          isFirstPage: true,
          hasStartDateFilter: false,
          enabled: false,
        }),
      { wrapper: makeWrapper(queryClient) },
    );

    expect(connectSpy).not.toHaveBeenCalled();
    expect(subscribeSpy).not.toHaveBeenCalled();
  });
});
