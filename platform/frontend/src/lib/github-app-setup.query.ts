import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toApiError } from "@/lib/utils/api";

/**
 * GitHub's return from creating a GitHub App from a manifest, for any setup
 * that registers Apps (Guardrails, GitHub Copilot). The answer says which
 * setup started it.
 */
export function useCompleteGithubAppSetup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.CompleteGithubAppSetupData["body"],
    ) => {
      const { data, error } = await archestraApiSdk.completeGithubAppSetup({
        body,
      });
      if (error) throw toApiError(error);
      return data;
    },
    onSuccess: () => {
      // The setup that started it reads its pending App afresh.
      client.invalidateQueries({ queryKey: ["openappa", "github-app"] });
      client.invalidateQueries({ queryKey: ["github-copilot-app", "pending"] });
    },
  });
}
