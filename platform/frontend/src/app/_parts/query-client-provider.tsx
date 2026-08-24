"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useState } from "react";
import { useSession } from "@/lib/auth/auth.query";
import {
  clearPersistedQueryCache,
  restorePersistedQueryCache,
  startPersistingQueryCache,
  syncPersistedQueryCacheScope,
} from "@/lib/query-persistence";

export const ArchestraQueryClientProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // With SSR, we want to set some default staleTime
            // above 0 to avoid refetching immediately on the client
            staleTime: 60 * 1_000,
            throwOnError: false,
            retry: false,
          },
        },
      }),
  );

  // Restoring in a layout effect keeps the hydration render byte-identical to
  // the server's — the snapshot lands after it, but still before the browser
  // paints, so a refresh never shows the empty state on its way to the cached
  // one. Queries the children already kicked off keep running and replace the
  // restored values in place when they answer.
  useIsomorphicLayoutEffect(() => {
    restorePersistedQueryCache(queryClient);
  }, [queryClient]);

  useEffect(() => startPersistingQueryCache(queryClient), [queryClient]);

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
