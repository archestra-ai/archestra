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
import { useReadiness } from "@/lib/config/health.query";

const HEALTHY_POLL_MS = 30_000;
const FAILING_POLL_MS = 5_000;
// Consecutive failed readiness polls before showing an app-wide warning.
// Hysteresis: a single blip must not flip the whole app to an error banner.
const UNREACHABLE_FAILURE_THRESHOLD = 2;

export type ConnectivityState =
  | { kind: "online" }
  | { kind: "browser-offline" }
  | { kind: "backend-unreachable" }
  | { kind: "database-unavailable" };

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
  const [unavailableKind, setUnavailableKind] = useState<
    "backend-unreachable" | "database-unavailable" | null
  >(null);
  const consecutiveFailuresRef = useRef(0);
  const lastFailureKindRef = useRef<
    "backend-unreachable" | "database-unavailable" | null
  >(null);

  // `/ready` is unauthenticated and probes the database. It distinguishes a
  // reachable backend with a failed database from an unreachable backend.
  const { refetch, data, isSuccess, isError, dataUpdatedAt, errorUpdatedAt } =
    useReadiness({
      refetchOnReconnect: false,
      // Poll speed follows the query's own error status (immediate), so a failing
      // backend is re-probed quickly. The unreachable *threshold* below is a
      // separate counter, so polling fast and declaring unreachable stay decoupled.
      refetchInterval: (query) =>
        query.state.status === "error" ||
        query.state.data?.database === "disconnected"
          ? FAILING_POLL_MS
          : HEALTHY_POLL_MS,
    });

  // Count repeated results of the same failure mode. The timestamps re-run
  // this effect when a second poll settles with an unchanged status.
  // biome-ignore lint/correctness/useExhaustiveDependencies: timestamps re-trigger repeated settled polls
  useEffect(() => {
    const failureKind = isError
      ? "backend-unreachable"
      : isSuccess && data?.database === "disconnected"
        ? "database-unavailable"
        : null;

    if (!failureKind && isSuccess) {
      consecutiveFailuresRef.current = 0;
      lastFailureKindRef.current = null;
      setUnavailableKind(null);
    } else if (failureKind) {
      consecutiveFailuresRef.current =
        lastFailureKindRef.current === failureKind
          ? consecutiveFailuresRef.current + 1
          : 1;
      lastFailureKindRef.current = failureKind;
      if (consecutiveFailuresRef.current >= UNREACHABLE_FAILURE_THRESHOLD) {
        setUnavailableKind(failureKind);
      }
    }
  }, [isSuccess, isError, data?.database, dataUpdatedAt, errorUpdatedAt]);

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
    : (unavailableKind ?? "online");

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
