import { archestraApiSdk } from "@shared";
import { useSuspenseQuery } from "@tanstack/react-query";

const { getPolicyConfigSubagentPrompt } = archestraApiSdk;

export function usePolicyConfigSubagentPrompt() {
  return useSuspenseQuery({
    queryKey: ["policy-config-subagent", "prompt"],
    queryFn: async () => {
      const result = await getPolicyConfigSubagentPrompt();
      return result.data?.promptTemplate ?? "";
    },
  });
}
