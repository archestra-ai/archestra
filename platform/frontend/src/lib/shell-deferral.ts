"use client";

import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

/**
 * Whether the app shell may start its non-critical requests yet (nav dots,
 * banner, sidebar warnings, the registry badge, onboarding prompts). On a hard
 * load these would otherwise start together with the page's own first data
 * request and compete with it. True once the first wave of requests has
 * settled, or after a bounded fallback; it then stays true for the session,
 * so client-side navigations within the mounted shell never wait.
 */
export function useShellDeferred(): boolean {
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
    // Driven by the query cache's own events: idle means no query is
    // fetching. A short settle window lets a request that starts right after
    // another finishes (the page's data after the session) count as the same
    // wave.
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
