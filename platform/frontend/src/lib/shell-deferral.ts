"use client";

import {
  type Query,
  type QueryClient,
  type QueryKey,
  useQueryClient,
} from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";

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

/**
 * Record that the server rendered this page with the shell's data in the
 * HTML (see `prefetchShellSeed`). Call it once, as the query cache is
 * created. The page's first data is then already there, so the shell's
 * deferred requests start as soon as the cache is idle instead of waiting
 * for a first wave that never comes.
 */
export function markShellSeeded(client: QueryClient): void {
  seededClients.add(client);
}

/** Whether the server rendered this page with the shell's data. */
export function useIsShellSeeded(): boolean {
  return seededClients.has(useQueryClient());
}

/**
 * Whether a query still holds the value this document's server seed wrote:
 * no fetch has replaced it, and the page load is recent. A page that needs a
 * fresh read on mount (the connection approval page) can count that value as
 * its read, because the server made it for this document's request. Later
 * mounts, and any refresh, read from the endpoint as usual.
 */
export function isDocumentSeedFresh(
  client: QueryClient,
  query: Pick<Query, "state"> | undefined,
): boolean {
  return (
    seededClients.has(client) &&
    !!query &&
    query.state.dataUpdateCount === 1 &&
    query.state.fetchStatus === "idle" &&
    Date.now() - query.state.dataUpdatedAt < DOCUMENT_SEED_FRESH_MS
  );
}

/**
 * {@link isDocumentSeedFresh} for one query, decided on the first render and
 * kept for the life of the component, so the server and the hydrating
 * browser render the same thing.
 */
export function useDocumentSeedFresh(queryKey: QueryKey): boolean {
  const client = useQueryClient();
  const [fresh] = useState(() =>
    isDocumentSeedFresh(client, client.getQueryCache().find({ queryKey })),
  );
  return fresh;
}

// === Internal helpers

class ShellDeferral {
  private released = false;
  private listeners = new Set<() => void>();
  private stop: () => void = () => {};

  constructor(client: QueryClient) {
    // A seeded page has had its first wave on the server.
    let sawFetch = seededClients.has(client);
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
    if (sawFetch) {
      settleTimer = setTimeout(() => {
        settleTimer = undefined;
        if (client.isFetching() === 0) this.release();
      }, SETTLE_MS);
    }
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

/** How long after the page load a seeded value still counts as the page's own read. */
const DOCUMENT_SEED_FRESH_MS = 30_000;

const deferrals = new WeakMap<QueryClient, ShellDeferral>();

const seededClients = new WeakSet<QueryClient>();
