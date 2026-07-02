import { archestraApiSdk } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { handleApiError, throwOnApiError } from "@/lib/utils";

const { getOnboardingSteps, completeOnboardingStep } = archestraApiSdk;

const ONBOARDING_QUERY_KEY = ["onboarding", "steps"] as const;

/** The set of onboarding step keys the current user has completed. */
export function useOnboardingSteps(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ONBOARDING_QUERY_KEY,
    enabled: options?.enabled ?? true,
    // Progress only grows and we update the cache optimistically on completion,
    // so there's no need to refetch during a session.
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      const { data, error } = await getOnboardingSteps();
      if (error) {
        handleApiError(error);
        return new Set<string>();
      }
      return new Set(data?.completedKeys ?? []);
    },
  });
}

/**
 * Mark a step complete for the current user. Optimistically adds the key so the
 * dot disappears instantly; the write is idempotent server-side.
 */
export function useCompleteOnboardingStep() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (stepKey: string) => {
      const { error } = await completeOnboardingStep({ body: { stepKey } });
      // Throw on failure so onError rolls back the optimistic cache update.
      throwOnApiError(error);
      return stepKey;
    },
    onMutate: async (stepKey) => {
      await queryClient.cancelQueries({ queryKey: ONBOARDING_QUERY_KEY });
      const previous =
        queryClient.getQueryData<Set<string>>(ONBOARDING_QUERY_KEY);
      const next = new Set(previous ?? []);
      next.add(stepKey);
      queryClient.setQueryData(ONBOARDING_QUERY_KEY, next);
      return { previous };
    },
    onError: (_error, _stepKey, context) => {
      if (context?.previous) {
        queryClient.setQueryData(ONBOARDING_QUERY_KEY, context.previous);
      }
    },
  });
}
