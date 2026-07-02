import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { throwOnApiError } from "@/lib/utils";

const { getOnboardingSurveyStatus, submitOnboardingSurvey } = archestraApiSdk;

type SubmitBody = NonNullable<
  archestraApiTypes.SubmitOnboardingSurveyData["body"]
>;

const SURVEY_STATUS_QUERY_KEY = ["onboarding", "survey", "status"] as const;

/**
 * Whether the one-time onboarding survey still needs collecting for this org.
 * Gate the query on `enabled` (admins only) so non-admins never fetch it.
 */
export function useOnboardingSurveyStatus(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: SURVEY_STATUS_QUERY_KEY,
    enabled: options?.enabled ?? true,
    // Answered-once and invalidated on submit, so no session refetching needed.
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      const { data, error } = await getOnboardingSurveyStatus();
      throwOnApiError(error);
      return data?.needsSubmission ?? false;
    },
  });
}

/** Submit the survey; clears the "needs submission" state on success. */
export function useSubmitOnboardingSurvey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: SubmitBody) => {
      const { error } = await submitOnboardingSurvey({ body });
      throwOnApiError(error);
    },
    onSuccess: () => {
      queryClient.setQueryData(SURVEY_STATUS_QUERY_KEY, false);
    },
  });
}
