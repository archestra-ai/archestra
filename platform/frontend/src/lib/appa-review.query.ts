import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils";

const {
  acknowledgeAppaQuarantine,
  decideAppaApproval,
  getAppaQuarantine,
  listAppaApprovals,
  listAppaQuarantines,
} = archestraApiSdk;

export type AppaApprovalReview =
  archestraApiTypes.ListAppaApprovalsResponses["200"][number];
export type AppaQuarantineReview =
  archestraApiTypes.ListAppaQuarantinesResponses["200"][number];

const appaReviewKeys = {
  approvals: () => ["appa-review", "approvals"] as const,
  quarantineList: () => ["appa-review", "quarantines"] as const,
  quarantine: (id: string) => ["appa-review", "quarantines", id] as const,
};

export function useAppaApprovals() {
  return useQuery({
    queryKey: appaReviewKeys.approvals(),
    refetchInterval: 2_000,
    queryFn: async () => {
      const { data, error } = await listAppaApprovals();
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
  });
}

export function useAppaQuarantines() {
  return useQuery({
    queryKey: appaReviewKeys.quarantineList(),
    refetchInterval: 2_000,
    queryFn: async () => {
      const { data, error } = await listAppaQuarantines();
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
  });
}

export function useAppaQuarantine(id: string | null) {
  return useQuery({
    queryKey: appaReviewKeys.quarantine(id ?? "none"),
    enabled: id !== null,
    queryFn: async () => {
      if (!id) return null;
      const { data, error } = await getAppaQuarantine({ path: { id } });
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
  });
}

export function useDecideAppaApproval() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      decision,
    }: {
      id: string;
      decision: "approve" | "deny";
    }) => {
      const { data, error } = await decideAppaApproval({
        path: { id },
        body: { decision },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: (_, variables) => {
      toast.success(
        variables.decision === "approve"
          ? "Approval recorded"
          : "Denial recorded",
      );
      queryClient.invalidateQueries({ queryKey: appaReviewKeys.approvals() });
    },
  });
}

export function useAcknowledgeAppaQuarantine() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      acknowledgment,
    }: {
      id: string;
      acknowledgment: "acknowledged" | "reconciled";
    }) => {
      const { data, error } = await acknowledgeAppaQuarantine({
        path: { id },
        body: { acknowledgment },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: (_, variables) => {
      toast.success(
        variables.acknowledgment === "acknowledged"
          ? "Quarantine acknowledgment recorded"
          : "Quarantine reconciliation recorded",
      );
      queryClient.invalidateQueries({
        queryKey: appaReviewKeys.quarantineList(),
      });
      queryClient.invalidateQueries({
        queryKey: appaReviewKeys.quarantine(variables.id),
      });
    },
  });
}
