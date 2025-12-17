import { archestraApiSdk } from "@shared";
import { useSuspenseQuery } from "@tanstack/react-query";

const { getApiPolicyConfigSubagentPrompt } = archestraApiSdk;

export function usePolicyConfigSubagentPrompt() {
  return useSuspenseQuery({
    queryKey: ["policy-config-subagent", "prompt"],
    queryFn: async () => {
      const result = await getApiPolicyConfigSubagentPrompt();
      return result.data?.promptTemplate ?? "";
    },
  });
}
