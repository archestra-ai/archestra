import { archestraApiSdk } from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { throwOnApiError } from "@/lib/utils";

const { getChatMetaAgent } = archestraApiSdk;

/** The in-app assistant agent; fetched once the dialog is first opened. */
export function useMetaAgent(enabled: boolean) {
  return useQuery({
    queryKey: ["chat", "meta-agent"],
    queryFn: async () => {
      const { data, error } = await getChatMetaAgent();
      // The dialog renders its own error state.
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
