"use client";

import {
  hashKey,
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { appLifecycle } from "@/lib/app-lifecycle";
import {
  authQueryKeys,
  seedShellQueries,
  useAllPermissions,
  useSession,
} from "@/lib/auth/auth.query";
import type { ShellSeed } from "@/lib/auth/shell-seed.server";
import {
  clearPersistedQueryCache,
  DEFAULT_STALE_TIME,
  restorePersistedQueryCache,
  startPersistingQueryCache,
  syncPersistedQueryCacheScope,
} from "@/lib/query-persistence";
import { markShellSeeded } from "@/lib/shell-deferral";
import { getApiRefusal } from "@/lib/utils/api";

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
    const client: QueryClient = new QueryClient({
      queryCache: new QueryCache({
        onError: (error) => recheckSessionWhenRefused(client, error),
      }),
      mutationCache: new MutationCache({
        onError: (error) => recheckSessionWhenRefused(client, error),
      }),
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
      <PermissionScopedCache client={queryClient} />
      {children}
    </QueryClientProvider>
  );
};

/**
 * A request refused as signed out, on a page that believes it is signed in,
 * means the session ended since it was last checked: it expired, or was
 * revoked. The session is asked again at once, so the shell follows (to the
 * sign-in page) instead of staying up with every action failing. A burst of
 * refusals shares one check.
 */
function recheckSessionWhenRefused(client: QueryClient, error: unknown) {
  if (getApiRefusal(error) !== "signed-out") return;
  if (!client.getQueryData(authQueryKeys.session())) return;
  void client.refetchQueries(
    { queryKey: authQueryKeys.session(), exact: true },
    { cancelRefetch: false },
  );
}

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

/**
 * Marks everything else in the cache outdated once the viewer's permissions
 * change. The lists and details held there were answered for the previous
 * role, and each would otherwise stay on screen until its own stale time ran
 * out. A refetch that returns the same map keeps the same object, so only a
 * real change gets here.
 */
function PermissionScopedCache({ client }: { client: QueryClient }) {
  const { data: permissions } = useAllPermissions();
  const previousPermissions = useRef(permissions);

  useEffect(() => {
    const previous = previousPermissions.current;
    previousPermissions.current = permissions;
    if (!previous || !permissions || previous === permissions) return;
    void client.invalidateQueries(
      {
        // All but the map itself, which is what just answered.
        predicate: (query) =>
          query.queryHash !== hashKey(authQueryKeys.userPermissions()),
      },
      // A request already on its way is answered for the new role.
      { cancelRefetch: false },
    );
  }, [client, permissions]);

  return null;
}

const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;
