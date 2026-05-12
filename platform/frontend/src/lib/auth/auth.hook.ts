import { useSession } from "@/lib/auth/auth.query";

export function useIsAuthenticated() {
  const session = useSession();
  return session.data?.user != null;
}
