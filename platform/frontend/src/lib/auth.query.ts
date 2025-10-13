import { useQuery } from "@tanstack/react-query";
import { authClient } from "@/lib/clients/auth/auth-client";

/**
 * Query key factory for auth-related queries
 */
export const authKeys = {
  all: ["auth"] as const,
  session: () => [...authKeys.all, "session"] as const,
};

/**
 * Fetch current session
 */
export function useSession() {
  return useQuery({
    queryKey: authKeys.session(),
    queryFn: async () => {
      const { data } = await authClient.getSession();
      return data;
    },
  });
}
