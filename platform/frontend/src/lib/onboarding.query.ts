import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { organizationKeys } from "@/lib/organization.query";

interface OnboardingLogsStatus {
  hasLlmProxyLogs: boolean;
  hasMcpGatewayLogs: boolean;
}

/**
 * Query key factory for onboarding-related queries
 */
export const onboardingKeys = {
  all: ["onboarding"] as const,
  logs: () => [...onboardingKeys.all, "logs"] as const,
};

/**
 * Check for LLM proxy and MCP gateway logs (only used during onboarding)
 * Only polls when enabled
 */
export function useOnboardingLogs(enabled: boolean) {
  return useQuery({
    queryKey: onboardingKeys.logs(),
    queryFn: async (): Promise<OnboardingLogsStatus> => {
      const response = await fetch("/api/onboarding/logs-status");

      if (!response.ok) {
        throw new Error("Failed to fetch onboarding logs status");
      }

      return await response.json();
    },
    refetchInterval: enabled ? 3000 : false, // Poll every 3 seconds when dialog is open
    enabled, // Only run query when enabled
  });
}

/**
 * Complete onboarding mutation
 */
export function useCompleteOnboarding() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/onboarding/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(
          error.error?.message || "Failed to complete onboarding",
        );
      }

      return await response.json();
    },
    onSuccess: () => {
      // Invalidate organization details to refresh onboardingComplete status
      queryClient.invalidateQueries({ queryKey: organizationKeys.details() });
      toast.success("Onboarding completed successfully!");
    },
    onError: (error) => {
      toast.error("Failed to complete onboarding", {
        description: error.message,
      });
    },
  });
}
