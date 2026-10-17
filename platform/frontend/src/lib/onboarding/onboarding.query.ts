import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useIsAuthenticated } from "@/lib/auth/auth.hook";
import { throwOnApiError } from "@/lib/utils/api";

export const onboardingKeys = {
  all: ["onboarding"] as const,
  seenNavItems: () => [...onboardingKeys.all, "seen-nav-items"] as const,
  surveyEligibility: () =>
    [...onboardingKeys.all, "survey-eligibility"] as const,
  feedbackPopupActivation: () =>
    [...onboardingKeys.all, "feedback-popup-activation"] as const,
};

/**
 * Onboarding nav items (red-dot nudges) the current user has already visited.
 * Only this client mutates the set, so the cache never goes stale. No error
 * toast: when the query fails the dots simply don't render.
 */
export function useSeenNavItems() {
  const isAuthenticated = useIsAuthenticated();
  return useQuery({
    queryKey: onboardingKeys.seenNavItems(),
    enabled: isAuthenticated,
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
 * Whether the first-login survey should be shown. Admin-only endpoint, so the
 * caller gates `enabled` on the admin permission. No error toast: on failure
 * the survey simply isn't shown.
 */
export function useOnboardingSurveyEligibility({
  enabled,
}: {
  enabled: boolean;
}) {
  return useQuery({
    queryKey: onboardingKeys.surveyEligibility(),
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
    queryFn: async () => {
      const { data, error } =
        await archestraApiSdk.getOnboardingSurveyEligibility();
      throwOnApiError(error, { toastOnError: false });
      return data ?? { eligible: false };
    },
  });
}

/**
 * When the instance got activated (MCP server connected + a successful tool
 * call routed) — the trigger signal for the feedback pop-up. Admin-only
 * endpoint, so the caller gates `enabled`. No error toast: on failure the
 * pop-up simply isn't shown.
 */
export function useFeedbackPopupActivation({ enabled }: { enabled: boolean }) {
  return useQuery({
    queryKey: onboardingKeys.feedbackPopupActivation(),
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
    queryFn: async () => {
      const { data, error } =
        await archestraApiSdk.getFeedbackPopupActivation();
      throwOnApiError(error, { toastOnError: false });
      return data ?? { activatedAt: null };
    },
  });
}

/**
 * Submit the first-login survey. The backend records it per organization and
 * eligibility flips off for good — the website forward is best-effort, so
 * this succeeds even on instances that can't reach the website.
 */
export function useSubmitOnboardingSurvey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.SubmitOnboardingSurveyData["body"],
    ) => {
      const { data, error } = await archestraApiSdk.submitOnboardingSurvey({
        body,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.setQueryData(onboardingKeys.surveyEligibility(), {
        eligible: false,
      });
    },
    onError: () => {
      toast.error("Couldn't submit — please try again");
    },
  });
}
