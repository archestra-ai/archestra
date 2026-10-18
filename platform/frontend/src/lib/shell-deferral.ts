"use client";

import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

/**
 * Whether the app shell may start its deferred requests: the nav dots, the
 * banner, the sidebar warnings, the registry badge, the onboarding survey and
 * the feedback popup. On a hard load, these requests compete with the page's
 * first data request. The hook returns true when the first wave of requests
 * settles, or after FALLBACK_MS. It then stays true, so client-side
 * navigations in the mounted shell do not wait.
 */
export function useShellReady(): boolean {
  const deferral = deferralFor(useQueryClient());
  return useSyncExternalStore(
    deferral.subscribe,
    deferral.isReleased,
    serverSnapshot,
  );
}

// === Internal helpers

class ShellDeferral {
  private released = false;
  private listeners = new Set<() => void>();
  private stop: () => void = () => {};

  constructor(client: QueryClient) {
    let sawFetch = false;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const fallback = setTimeout(() => this.release(), FALLBACK_MS);
    // The query cache's events drive the release. Idle means no query is
    // fetching. The cache must stay idle for SETTLE_MS, so a request that
    // starts just after another ends (the page's data after the session)
    // joins the same wave.
    const unsubscribe = client.getQueryCache().subscribe(() => {
      if (this.released) return;
      if (client.isFetching() > 0) {
        sawFetch = true;
        clearTimeout(settleTimer);
        settleTimer = undefined;
        return;
      }
      if (!sawFetch || settleTimer) return;
      settleTimer = setTimeout(() => {
        settleTimer = undefined;
        if (client.isFetching() === 0) this.release();
      }, SETTLE_MS);
    });
    this.stop = () => {
      clearTimeout(fallback);
      clearTimeout(settleTimer);
      unsubscribe();
    };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  isReleased = () => this.released;

  private release() {
    if (this.released) return;
    this.released = true;
    this.stop();
    for (const listener of this.listeners) listener();
  }
}

function deferralFor(client: QueryClient): ShellDeferral {
  let deferral = deferrals.get(client);
  if (!deferral) {
    deferral = new ShellDeferral(client);
    deferrals.set(client, deferral);
  }
  return deferral;
}

const serverSnapshot = () => false;

/** Longest the shell waits for the first wave of requests to settle. */
const FALLBACK_MS = 1500;

/** How long the cache must stay idle to count the first wave as settled. */
const SETTLE_MS = 50;

const deferrals = new WeakMap<QueryClient, ShellDeferral>();
