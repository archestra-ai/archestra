import {
  archestraApiSdk,
  ManagedResourceSchema,
  type Permissions,
  ResourcePermissionActionSchema,
} from "@archestra/shared";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import {
  hasPagePermissions,
  hasPermissions,
  pageUsesCapabilities,
} from "@/lib/auth/auth.utils";
import { sessionConfirmation } from "@/lib/auth/session-confirmation";
import { authClient } from "@/lib/clients/auth/auth-client";
import { PERSISTED_QUERY_META } from "@/lib/query-persistence";
import { throwOnApiError } from "@/lib/utils/api";

export const authQueryKeys = {
  all: ["auth"] as const,
  session: () => [...authQueryKeys.all, "session"] as const,
  sessions: () => [...authQueryKeys.all, "sessions"] as const,
  userPermissions: () => [...authQueryKeys.all, "userPermissions"] as const,
  // Under `all` so role, member and team changes, which invalidate it,
  // refresh object grants along with the permission map.
  scopedCapabilities: () =>
    [...authQueryKeys.all, "scopedCapabilities"] as const,
  defaultCredentialsEnabled: () =>
    [...authQueryKeys.all, "defaultCredentialsEnabled"] as const,
};

/**
 * Fetch the current session through the shared TanStack Query cache.
 *
 * Always use this hook instead of calling `authClient.getSession()` directly in
 * components/hooks. This keeps every session consumer on one query key with the
 * same stale-time and invalidation path, and prevents repeated session requests
 * when many auth-aware components mount together.
 */
export function useSession() {
  return useQuery({
    queryKey: authQueryKeys.session(),
    queryFn: async ({ client: queryClient }) => {
      // Cold load only: a refresh restores the session from the persisted
      // snapshot, and the shell's queries are already running by then. The
      // seed runs alongside the session check but nothing waits on it here:
      // the queries it fills await it themselves (awaitBootstrapSeed).
      const isColdLoad =
        queryClient.getQueryData(authQueryKeys.session()) === undefined;
      if (isColdLoad) startBootstrapSeed(queryClient);
      const { data, error } = await authClient.getSession();
      // An explicit authentication refusal clears the shell. An unavailable
      // server must enter the query's error state and retain the last session.
      if (error?.status === 401 || error?.status === 403) {
        sessionConfirmation.set(false);
        return null;
      }
      throwOnApiError(error, { toastOnError: false });
      sessionConfirmation.set(!!data?.user);
      return data;
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    // Keep focus refetching on so backgrounded tabs discover revoked or changed sessions promptly.
    refetchOnWindowFocus: true,
    // Restored on refresh so the shell renders straight away instead of
    // sitting behind a session check. The persisted copy is stripped of the
    // session token, and the request below still runs and replaces it.
    meta: PERSISTED_QUERY_META,
  });
}

/**
 * Checks user permissions, resolving to true or false.
 * Under the hood, fetches all user permissions and re-uses this permission cache.
 */
export function useHasPermissions(
  permissionsToCheck: Permissions,
  permissionScope?: string,
) {
  const capabilities = useScopedCapabilities(permissionScope !== undefined);
  const {
    data: userPermissions,
    isPending,
    isLoading,
    isError,
    error,
    isSuccess,
    status,
  } = useAllPermissions();

  const scopedCheck = permissionScope !== undefined;
  const missingPermissions: Permissions = {};
  for (const [resource, actions] of Object.entries(permissionsToCheck)) {
    const missingActions = actions.filter((action) =>
      scopedCheck &&
      ManagedResourceSchema.safeParse(resource).success &&
      ResourcePermissionActionSchema.safeParse(action).success
        ? !capabilities.data?.some(
            (grant) =>
              grant.resource === resource &&
              grant.action === action &&
              (grant.scope === "*" || grant.scope === permissionScope),
          )
        : !hasPermissions(userPermissions, { [resource]: [action] }),
    );
    if (missingActions.length) {
      missingPermissions[resource as keyof Permissions] = missingActions;
    }
  }
  const hasPermissionResult = Object.keys(missingPermissions).length === 0;

  return {
    data: hasPermissionResult,
    missingPermissions,
    isPending: isPending || (scopedCheck && capabilities.isPending),
    isLoading: isLoading || (scopedCheck && capabilities.isLoading),
    isError,
    error,
    isSuccess,
    status,
  };
}

/**
 * Page discovery accepts an object read grant; it does not imply global read.
 * A page that no grant can open does not wait for the scoped capabilities.
 */
export function useHasPagePermissions(required: Permissions) {
  const needsCapabilities = pageUsesCapabilities(required);
  const permissions = useAllPermissions();
  const capabilities = useScopedCapabilities(needsCapabilities);
  return {
    data: hasPagePermissions({
      userPermissions: permissions.data,
      required,
      capabilities: capabilities.data ?? [],
    }),
    isPending:
      permissions.isPending || (needsCapabilities && capabilities.isPending),
  };
}

export function useScopedCapabilities(enabled = true) {
  const { data: session } = useSession();
  return useQuery({
    queryKey: authQueryKeys.scopedCapabilities(),
    enabled: enabled && !!session?.user,
    queryFn: async ({ client }) => {
      const seed = await awaitBootstrapSeed(client);
      if (seed) return seed.scopedCapabilities;
      const { data, error } = await archestraApiSdk.getScopedCapabilities();
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
    // Same lifetime as the permission map it completes: page guards wait on
    // both, so restoring only one would leave a guarded page empty on refresh.
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    meta: PERSISTED_QUERY_META,
  });
}

/**
 * Returns only the permissions the user is missing from the required set.
 * Useful for showing specific missing permissions in tooltips.
 */
export function useMissingPermissions(
  requiredPermissions: Permissions,
): Permissions {
  const { data: userPermissions } = useAllPermissions();

  if (
    !requiredPermissions ||
    Object.keys(requiredPermissions).length === 0 ||
    !userPermissions
  ) {
    return requiredPermissions;
  }

  const missing: Permissions = {};

  for (const [resource, actions] of Object.entries(requiredPermissions)) {
    const userActions = userPermissions[resource as keyof Permissions] ?? [];
    const missingActions = actions.filter(
      (a) => !(userActions as readonly string[]).includes(a),
    );
    if (missingActions.length > 0) {
      missing[resource as keyof Permissions] = missingActions;
    }
  }

  return missing;
}

/**
 * Low-level query which fetches the dictionary of all user permissions.
 * Avoid using directly in components and use useHasPermissions instead.
 */
export function useAllPermissions() {
  const { data: session, isPending: isSessionPending } = useSession();
  const isAuthenticated = !!session?.user;

  return useQuery({
    queryKey: authQueryKeys.userPermissions(),
    queryFn: async ({ client }) => {
      const seed = await awaitBootstrapSeed(client);
      if (seed) return seed.permissions;
      const { data, error } = await archestraApiSdk.getUserPermissions();
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
    retry: false,
    throwOnError: false,
    enabled: !isSessionPending && isAuthenticated,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    // Decides which nav items and pages exist, so restoring it is what lets
    // the sidebar come back with its real contents rather than empty.
    meta: PERSISTED_QUERY_META,
  });
}

/**
 * Resolves the permission map with given keys and results of permission checks as values.
 * Use in cases where multiple useHasPermissions calls are impossible.
 * @returns A record with the same keys as the input map and boolean values indicating permission checks, or null if still loading.
 */
export function usePermissionMap<Key extends string>(
  map: Record<Key, Permissions>,
): Record<Key, boolean> | null {
  const { data: userPermissions, isLoading } = useAllPermissions();
  const capabilities = useScopedCapabilities();

  if (isLoading || (userPermissions === undefined && capabilities.isLoading)) {
    return null;
  }

  const result = {} as Record<Key, boolean>;

  for (const [key, requiredPermissions] of Object.entries(map) as [
    Key,
    Permissions,
  ][]) {
    result[key] = hasPagePermissions({
      userPermissions,
      required: requiredPermissions,
      capabilities: capabilities.data ?? [],
    });
  }

  return result;
}

/**
 * Whether the default admin credentials are still active. `enabled: false`
 * skips the request. The sidebar warnings pass it for viewers who never see
 * the default-credentials warning.
 */
export function useDefaultCredentialsEnabled({
  enabled = true,
}: {
  enabled?: boolean;
} = {}) {
  return useQuery({
    queryKey: authQueryKeys.defaultCredentialsEnabled(),
    enabled,
    queryFn: async () => {
      const { data, error } =
        await archestraApiSdk.getDefaultCredentialsStatus();
      throwOnApiError(error, { toastOnError: false });
      return data?.enabled ?? false;
    },
    // Refetch when window is focused to catch password changes
    refetchOnWindowFocus: true,
    // Keep data fresh with shorter stale time
    staleTime: 10000, // 10 seconds
  });
}

// ===

type BootstrapData = NonNullable<
  Awaited<ReturnType<typeof archestraApiSdk.getBootstrap>>["data"]
>;

/**
 * The cold load's `/api/bootstrap` answer while it is in flight, so a query it
 * seeds that becomes enabled first (the session usually answers sooner) waits
 * for it instead of starting a second request. Cleared once settled: later
 * fetches of those queries are refreshes and go to their own endpoints.
 */
const bootstrapSeeds = new WeakMap<
  QueryClient,
  Promise<BootstrapData | null>
>();

/**
 * Await the in-flight bootstrap seed, if any. Resolves to null when there is
 * none or it failed, and the caller fetches its own endpoint.
 *
 * @public — also awaited by the config and organization queries
 */
export async function awaitBootstrapSeed(
  queryClient: QueryClient,
): Promise<BootstrapData | null> {
  return (await bootstrapSeeds.get(queryClient)) ?? null;
}

/**
 * Seeds the queries the app shell reads (permissions, scoped capabilities,
 * organization, config) from one `/api/bootstrap` request, fired alongside
 * the session check on a cold load, so those queries are already fresh when
 * the session resolves and enables them, instead of starting a second wave.
 *
 * Best-effort: when signed out or on any failure nothing is seeded and each
 * query fetches its own endpoint as before. The keys are spelled out rather
 * than imported because the modules owning them import this one.
 */
function startBootstrapSeed(queryClient: QueryClient) {
  if (bootstrapSeeds.has(queryClient)) return;
  const seed = (async () => {
    try {
      const { data } = await archestraApiSdk.getBootstrap();
      if (!data) return null;
      queryClient.setQueryData(
        authQueryKeys.userPermissions(),
        data.permissions,
      );
      queryClient.setQueryData(
        authQueryKeys.scopedCapabilities(),
        data.scopedCapabilities,
      );
      queryClient.setQueryData(["config"], data.config);
      if (data.organization) {
        queryClient.setQueryData(
          ["organization", "details"],
          data.organization,
        );
      }
      return data;
    } catch {
      // Fall back to the individual requests.
      return null;
    } finally {
      bootstrapSeeds.delete(queryClient);
    }
  })();
  bootstrapSeeds.set(queryClient, seed);
}
