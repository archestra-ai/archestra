import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useIsAuthenticated } from "@/lib/auth/use-is-authenticated";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils/api";

export const onboardingKeys = {
  all: ["onboarding"] as const,
  seenNavItems: () => [...onboardingKeys.all, "seen-nav-items"] as const,
  firstRunSetup: () => [...onboardingKeys.all, "first-run-setup"] as const,
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

/**
 * Whether the first-run setup dialog should be shown. Admin-only endpoint, so
 * the caller gates `enabled` on the admin permission. No error toast: on
 * failure the dialog simply isn't shown.
 */
export function useFirstRunSetup({ enabled }: { enabled: boolean }) {
  return useQuery({
    queryKey: onboardingKeys.firstRunSetup(),
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getFirstRunSetup();
      throwOnApiError(error, { toastOnError: false });
      return data ?? { show: false };
    },
  });
}

/**
 * Finish the first-run setup dialog. The email goes straight from the browser
 * to the Loops signup form; only the telemetry choice reaches the backend,
 * which records it per organization so the dialog never opens again. The
 * signup is best-effort, so this succeeds even when Loops can't be reached.
 */
export function useCompleteFirstRunSetup() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      email,
      telemetryEnabled,
    }: {
      email?: string;
      telemetryEnabled: boolean;
    }) => {
      if (email) await subscribeToMailingList(email);
      const { data, error } = await archestraApiSdk.completeFirstRunSetup({
        body: { telemetryEnabled },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: (_data, body) => {
      queryClient.setQueryData(onboardingKeys.firstRunSetup(), { show: false });
      if (!body.telemetryEnabled) {
        // Stops PostHog and error reporting in this tab right away (see
        // PostHogProviderWrapper); other tabs follow on their next load.
        queryClient.setQueryData<
          archestraApiTypes.GetPublicConfigResponses["200"] | null
        >(["public-config"], (current) =>
          current
            ? {
                ...current,
                analytics: { ...current.analytics, enabled: false },
              }
            : current,
        );
      }
    },
  });
}

// === Internal helpers ===

/**
 * Archestra's Loops signup form (Loops app: Forms, Settings, Form Endpoint).
 * A public endpoint: it only adds contacts, so it is safe to ship.
 */
const LOOPS_FORM_ENDPOINT =
  "https://app.loops.so/api/newsletter-form/cmdehe4lw18tnwy0ifkz89qqk";

/**
 * Add the email to Archestra's mailing list through the public Loops form
 * endpoint. Best-effort: a failure (offline, airgapped, rate-limited) is
 * ignored, since asking the admin again is worse than missing one signup.
 */
async function subscribeToMailingList(email: string): Promise<void> {
  try {
    await fetch(LOOPS_FORM_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      // white-label-ok: wire identifier for the contact's source in Archestra's own Loops account
    body: new URLSearchParams({ email, source: "Archestra platform" }),
      signal: AbortSignal.timeout(LOOPS_TIMEOUT_MS),
    });
  } catch {
    // Best-effort, see above.
  }
}

const LOOPS_TIMEOUT_MS = 10_000;
