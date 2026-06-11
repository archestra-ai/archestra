import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { authQueryKeys } from "@/lib/auth/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";

export function useListSessions() {
  return useQuery({
    queryKey: authQueryKeys.sessions(),
    queryFn: async () => {
      const { data, error } = await authClient.listSessions();
      if (error) {
        toast.error(error.message ?? "Failed to load sessions");
        return [];
      }
      return data ?? [];
    },
  });
}

/**
 * Revoke a (non-current) session by token. Revoking the current session is
 * handled by navigating to /auth/sign-out instead.
 */
export function useRevokeSessionMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { token: string }) => {
      const { error } = await authClient.revokeSession({
        token: params.token,
      });
      if (error) {
        toast.error(error.message ?? "Failed to revoke session");
        return false;
      }
      return true;
    },
    onSuccess: async (revoked) => {
      if (!revoked) return;
      toast.success("Session revoked");
      await queryClient.invalidateQueries({
        queryKey: authQueryKeys.sessions(),
      });
    },
  });
}
