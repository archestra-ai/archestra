import { archestraApiSdk } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useIsAuthenticated } from "@/lib/auth/use-is-authenticated";
import { throwOnApiError } from "@/lib/utils/api";

export const onboardingKeys = {
  all: ["onboarding"] as const,
  seenNavItems: () => [...onboardingKeys.all, "seen-nav-items"] as const,
};

/**
 * Onboarding nav items (red-dot nudges) the current user has already visited.
 * Only this client mutates the set, so the cache never goes stale. No error
 * toast: when the query fails the dots simply don't render.
 */
export function useSeenNavItems({
  enabled = true,
}: {
  enabled?: boolean;
} = {}) {
  const isAuthenticated = useIsAuthenticated();
  return useQuery({
    queryKey: onboardingKeys.seenNavItems(),
    enabled: enabled && isAuthenticated,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getOnboardingSeenNavItems();
      throwOnApiError(error, { toastOnError: false });
      return data ?? { items: [] };
    },
  });
}

/**
 * Mark onboarding nav items as visited. Optimistic — the dot disappears
 * immediately — and deliberately silent on failure (the dot reappearing on
 * the next load is the only consequence; a toast would be noise).
 */
export function useMarkNavItemsSeen() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (items: string[]) => {
      const { data, error } = await archestraApiSdk.markOnboardingNavItemsSeen({
        body: { items },
      });
      if (error) throw error;
      return data;
    },
    onMutate: async (items) => {
      queryClient.setQueryData(
        onboardingKeys.seenNavItems(),
        (previous: { items: string[] } | undefined) => ({
          items: [...new Set([...(previous?.items ?? []), ...items])],
        }),
      );
    },
    onSuccess: (data) => {
      if (data) queryClient.setQueryData(onboardingKeys.seenNavItems(), data);
    },
    onError: () => {
      void queryClient.invalidateQueries({
        queryKey: onboardingKeys.seenNavItems(),
      });
    },
  });
}
