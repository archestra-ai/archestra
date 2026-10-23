"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useState } from "react";
import { appLifecycle } from "@/lib/app-lifecycle";
import { seedShellQueries, useSession } from "@/lib/auth/auth.query";
import type { ShellSeed } from "@/lib/auth/shell-seed.server";
import {
  clearPersistedQueryCache,
  DEFAULT_STALE_TIME,
  restorePersistedQueryCache,
  startPersistingQueryCache,
  syncPersistedQueryCacheScope,
} from "@/lib/query-persistence";
import { markShellSeeded } from "@/lib/shell-deferral";

export const ArchestraQueryClientProvider = ({
  children,
  shellSeed,
}: {
  children: React.ReactNode;
  /**
   * The session and bootstrap the server resolved for this document, when
   * its page renders on the server. Seeded before anything renders, so the
   * shell's gates pass on the server and on the first browser render alike.
   */
  shellSeed?: ShellSeed | null;
}) => {
  const [queryClient] = useState(() => {
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          // With SSR, we want to set some default staleTime
          // above 0 to avoid refetching immediately on the client
          staleTime: DEFAULT_STALE_TIME,
          throwOnError: false,
          retry: false,
        },
      },
    });
    if (shellSeed) {
      markShellSeeded(client);
      seedShellQueries(client, shellSeed);
      for (const { queryKey, data } of shellSeed.queries) {
        client.setQueryData(queryKey, data);
      }
    }
    return client;
  });

  // Restoring in a layout effect keeps the hydration render byte-identical to
  // the server's — the snapshot lands after it, but still before the browser
  // paints, so a refresh never shows the empty state on its way to the cached
  // one. Queries the children already kicked off keep running and replace the
  // restored values in place when they answer.
  useIsomorphicLayoutEffect(() => {
    restorePersistedQueryCache(queryClient);
  }, [queryClient]);

  useEffect(() => startPersistingQueryCache(queryClient), [queryClient]);
  useEffect(() => appLifecycle.markRendered(), []);

  return (
    <QueryClientProvider client={queryClient}>
      <PersistedQueryCacheScope client={queryClient} />
      {children}
    </QueryClientProvider>
  );
};

/**
 * Binds the refresh snapshot to whoever is signed in. A snapshot belonging to
 * another user or another workspace is dropped rather than shown, and signing
 * out leaves nothing behind for the next person on this browser.
 */
function PersistedQueryCacheScope({ client }: { client: QueryClient }) {
  const { data: session, isPending } = useSession();
  const userId = session?.user?.id;
  const organizationId = session?.session?.activeOrganizationId ?? "none";

  useEffect(() => {
    if (isPending) return;
    if (!userId) {
      clearPersistedQueryCache();
      return;
    }
    syncPersistedQueryCacheScope(client, `${userId}:${organizationId}`);
  }, [client, isPending, userId, organizationId]);

  return null;
}

const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;
