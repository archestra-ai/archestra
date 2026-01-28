import { archestraApiSdk } from "@shared";
import { useQuery } from "@tanstack/react-query";

const { getPolicyConfigSubagentPrompt } = archestraApiSdk;

export function usePolicyConfigSubagentPrompt() {
  return useQuery({
    queryKey: ["policy-config-subagent", "prompt"],
    queryFn: async () => {
      const result = await getPolicyConfigSubagentPrompt();
      return result.data?.promptTemplate ?? "";
    },
  });
}
