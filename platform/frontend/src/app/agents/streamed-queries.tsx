"use client";

import {
  type DehydratedState,
  hydrate,
  useQueryClient,
} from "@tanstack/react-query";
import { type ReactNode, useState, useSyncExternalStore } from "react";
import { streamedQueries } from "@/lib/streamed-queries";

/**
 * Hands queries the server started to the page's own hooks, before they
 * render. Settled ones (what the page needs to build its query keys) are
 * hydrated as data; pending ones are adopted as an in-flight fetch of the
 * server's promise, so the page's hooks find them fetching and make no
 * request of their own, and their rows land when the promise does.
 *
 * Unlike `HydrationBoundary`, a pending query never takes data during a
 * hydration render, even when its promise has already settled: the server
 * rendered it pending, and so must the hydration render, or the two would
 * differ. Outside hydration (a client navigation, or a page mounted after the
 * app's client-side gates), an answer that has already arrived is taken as
 * data at once, so the first render shows it. A query
 * the browser already holds (restored on a refresh, or from an earlier visit)
 * keeps its rows on screen until the server's answer replaces them. The
 * adopted queries are marked as streamed, so a hook that mounts only after the
 * answer has landed takes it as fresh rather than fetching it again.
 */
export function StreamedQueries({
  state,
  children,
}: {
  state: DehydratedState;
  children: ReactNode;
}) {
  const client = useQueryClient();
  // True on the server and in the hydration render, false in any later render.
  const hydrating = useSyncExternalStore(
    subscribeToNothing,
    () => false,
    () => true,
  );
  // Once per mount, during render: the hooks below must see these queries on
  // their first render, and cache listeners are notified asynchronously.
  useState(() => adoptStreamedQueries({ client, state, hydrating }));
  return children;
}

// ===

function adoptStreamedQueries({
  client,
  state,
  hydrating,
}: {
  client: ReturnType<typeof useQueryClient>;
  state: DehydratedState;
  hydrating: boolean;
}) {
  hydrate(client, {
    ...state,
    queries: state.queries.filter(({ promise }) => !promise),
  });
  const cache = client.getQueryCache();
  for (const { queryKey, queryHash, meta, promise } of state.queries) {
    if (!promise) continue;
    const query = cache.build(client, { queryKey, queryHash, meta });
    streamedQueries.mark(query);
    if (query.state.fetchStatus !== "idle") continue;
    const settled = hydrating ? undefined : fulfilledValue(promise);
    if (settled) {
      query.setData(settled.value);
      continue;
    }
    // RSC-transformed promises are not thenable until wrapped.
    query
      .fetch(undefined, { initialPromise: Promise.resolve(promise) })
      .catch(() => {});
  }
}

/**
 * The value of a promise React has already seen settle (an RSC promise whose
 * row has arrived carries its status and value), without waiting a tick.
 */
function fulfilledValue(promise: unknown): { value: unknown } | undefined {
  const tracked = promise as { status?: string; value?: unknown };
  return tracked.status === "fulfilled" ? { value: tracked.value } : undefined;
}

function subscribeToNothing() {
  return () => {};
}
