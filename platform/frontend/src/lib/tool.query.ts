import { archestraApiSdk } from "@shared";
import { useQuery } from "@tanstack/react-query";

const { getTools } = archestraApiSdk;

/** Non-suspense version for use in dialogs/portals */
export function useTools() {
  return useQuery({
    queryKey: ["tools-dialog"],
    queryFn: async () => (await getTools()).data ?? null,
  });
}
