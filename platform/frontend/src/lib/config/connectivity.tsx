"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useHealth } from "@/lib/config/health.query";

const HEALTHY_POLL_MS = 30_000;
const FAILING_POLL_MS = 5_000;
// Consecutive failed /health polls before declaring the backend unreachable.
// Hysteresis: a single blip must not flip the whole app to an error banner.
const UNREACHABLE_FAILURE_THRESHOLD = 2;

export type ConnectivityState =
  | { kind: "online" }
  | { kind: "browser-offline" }
  | { kind: "backend-unreachable" };

interface ConnectivityContextValue {
  state: ConnectivityState;
  retry: () => void;
}

const ConnectivityContext = createContext<ConnectivityContextValue | null>(
  null,
);

export function ConnectivityProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  // SSR-safe: assume online during render, read the real value in an effect.
  const [browserOnline, setBrowserOnline] = useState(true);
  const [backendUnreachable, setBackendUnreachable] = useState(false);
  const consecutiveFailuresRef = useRef(0);

  // `/health` is unauthenticated, so its failures mean connectivity loss, never
  // an expired session. Poll slowly when healthy, fast once a failure appears.
  const { refetch, isSuccess, isError, errorUpdatedAt } = useHealth({
    refetchOnReconnect: false,
    // Poll speed follows the query's own error status (immediate), so a failing
    // backend is re-probed quickly. The unreachable *threshold* below is a
    // separate counter, so polling fast and declaring unreachable stay decoupled.
    refetchInterval: (query) =>
      query.state.status === "error" ? FAILING_POLL_MS : HEALTHY_POLL_MS,
  });

  // Fold each settled /health poll into the consecutive-failure counter that
  // drives the unreachable state. `errorUpdatedAt` is a dep — not read in the
  // body — because a second consecutive failure leaves `isError` already true,
  // so only its changing timestamp re-runs the effect to keep counting.
  // biome-ignore lint/correctness/useExhaustiveDependencies: errorUpdatedAt is the re-trigger for repeated failures
  useEffect(() => {
    if (isSuccess) {
      consecutiveFailuresRef.current = 0;
      setBackendUnreachable(false);
    } else if (isError) {
      consecutiveFailuresRef.current += 1;
      if (consecutiveFailuresRef.current >= UNREACHABLE_FAILURE_THRESHOLD) {
        setBackendUnreachable(true);
      }
    }
  }, [isSuccess, isError, errorUpdatedAt]);

  // Track the browser's own connectivity, and re-probe the backend the moment
  // it reports online (browser-online does not imply backend-reachable).
  useEffect(() => {
    setBrowserOnline(navigator.onLine);
    const handleOnline = () => {
      setBrowserOnline(true);
      void refetch();
    };
    const handleOffline = () => setBrowserOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [refetch]);

  const kind: ConnectivityState["kind"] = !browserOnline
    ? "browser-offline"
    : backendUnreachable
      ? "backend-unreachable"
      : "online";

  // On the transition back to fully online, refetch everything once so screens
  // that errored while offline recover — a single wave, not a per-screen storm.
  const prevKindRef = useRef<ConnectivityState["kind"]>("online");
  useEffect(() => {
    if (prevKindRef.current !== "online" && kind === "online") {
      void queryClient.invalidateQueries({ type: "active" });
    }
    prevKindRef.current = kind;
  }, [kind, queryClient]);

  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);

  // Memoized so consumers (the chat page among them) don't re-render on every
  // poll settle, only when the connectivity kind actually changes.
  const value = useMemo<ConnectivityContextValue>(
    () => ({ state: { kind }, retry }),
    [kind, retry],
  );

  return (
    <ConnectivityContext.Provider value={value}>
      {children}
    </ConnectivityContext.Provider>
  );
}

export function useConnectivity(): ConnectivityContextValue {
  const ctx = useContext(ConnectivityContext);
  if (!ctx) {
    throw new Error(
      "useConnectivity must be used within a ConnectivityProvider",
    );
  }
  return ctx;
}
