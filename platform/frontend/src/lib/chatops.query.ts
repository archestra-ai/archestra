import { archestraApiSdk } from "@shared";
import { useQuery } from "@tanstack/react-query";

export function useChatOpsStatus() {
  return useQuery({
    queryKey: ["chatops", "status"],
    queryFn: async () => {
      const response = await archestraApiSdk.getChatOpsStatus();
      return response.data?.providers || [];
    },
  });
}
