import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils/api";

type OpenappaReview = archestraApiTypes.GetOpenappaReviewResponses[200];

export function useOpenappaReview(params: {
  taskId: string | null;
  approvalId: string | null;
}) {
  return useQuery<OpenappaReview>({
    queryKey: ["openappa-review", params.taskId, params.approvalId],
    enabled: Boolean(params.taskId && params.approvalId),
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getOpenappaReview({
        path: { taskId: params.taskId ?? "" },
        query: { approvalId: params.approvalId ?? "" },
      });
      throwOnApiError(error, { toastOnError: false });
      if (!data) throw new Error("Review is unavailable");
      return data;
    },
  });
}

export function useSubmitOpenappaReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      taskId: string;
      approvalId: string;
      ruling: "approve" | "deny";
    }) => {
      const { data, error } = await archestraApiSdk.submitOpenappaReview({
        path: { taskId: params.taskId },
        body: { approvalId: params.approvalId, ruling: params.ruling },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: async (_data, params) => {
      await queryClient.invalidateQueries({
        queryKey: ["openappa-review", params.taskId, params.approvalId],
      });
    },
  });
}
