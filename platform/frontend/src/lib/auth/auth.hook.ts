import { authClient } from "@/lib/clients/auth/auth-client";

export function useIsAuthenticated() {
  const session = authClient.useSession();
  return session.data?.user != null;
}
