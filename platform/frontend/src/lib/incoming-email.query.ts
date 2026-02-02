import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "./utils";

const {
  getIncomingEmailStatus,
  setupIncomingEmailWebhook,
  renewIncomingEmailSubscription,
  deleteIncomingEmailSubscription,
  getAgentEmailAddress,
} = archestraApiSdk;

export const incomingEmailKeys = {
  all: ["incoming-email"] as const,
  status: () => [...incomingEmailKeys.all, "status"] as const,
  promptEmailAddress: (promptId: string) =>
    [...incomingEmailKeys.all, "prompt-email", promptId] as const,
};

export function useIncomingEmailStatus() {
  return useQuery({
    queryKey: incomingEmailKeys.status(),
    queryFn: async () => {
      const { data, error } = await getIncomingEmailStatus();
      if (error) {
        handleApiError(error);
        return null;
      }
      return data as archestraApiTypes.GetIncomingEmailStatusResponses["200"];
    },
  });
}

export function useSetupIncomingEmailWebhook() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (webhookUrl: string) => {
      const response = await setupIncomingEmailWebhook({
        body: { webhookUrl },
      });
      if (response.error) {
        handleApiError(response.error);
        return null;
      }
      return response.data as archestraApiTypes.SetupIncomingEmailWebhookResponses["200"];
    },
    onSuccess: () => {
      toast.success("Webhook subscription created successfully");
      queryClient.invalidateQueries({ queryKey: incomingEmailKeys.status() });
    },
  });
}

export function useRenewIncomingEmailSubscription() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const response = await renewIncomingEmailSubscription();
      if (response.error) {
        handleApiError(response.error);
        return null;
      }
      return response.data as archestraApiTypes.RenewIncomingEmailSubscriptionResponses["200"];
    },
    onSuccess: () => {
      toast.success("Subscription renewed successfully");
      queryClient.invalidateQueries({ queryKey: incomingEmailKeys.status() });
    },
  });
}

export function useDeleteIncomingEmailSubscription() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const response = await deleteIncomingEmailSubscription();
      if (response.error) {
        handleApiError(response.error);
        return null;
      }
      return response.data as archestraApiTypes.DeleteIncomingEmailSubscriptionResponses["200"];
    },
    onSuccess: () => {
      toast.success("Subscription deleted successfully");
      queryClient.invalidateQueries({ queryKey: incomingEmailKeys.status() });
    },
  });
}

/**
 * Hook to fetch the email address for a specific agent (internal agent)
 * Pass null to disable the query
 */
export function useAgentEmailAddress(agentId: string | null) {
  return useQuery({
    queryKey: incomingEmailKeys.promptEmailAddress(agentId ?? ""),
    queryFn: async () => {
      if (!agentId) return null;
      const { data, error } = await getAgentEmailAddress({
        path: { agentId },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data as archestraApiTypes.GetAgentEmailAddressResponses["200"];
    },
    enabled: !!agentId,
  });
}
