import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { authQueryKeys } from "@/lib/auth/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { throwOnApiError } from "@/lib/utils";

/**
 * Better Auth refuses `/list-sessions` for a session older than its freshness
 * window. Only signing in again clears it, so callers surface it as its own
 * state rather than offering a retry that is guaranteed to fail.
 */
export class StaleSessionError extends Error {
  constructor() {
    super("Session is not fresh");
    this.name = "StaleSessionError";
  }
}

export function useListSessions() {
  return useQuery({
    queryKey: authQueryKeys.sessions(),
    queryFn: async () => {
      const { data, error } = await authClient.listSessions();
      if (isSessionNotFreshError(error)) {
        throw new StaleSessionError();
      }
      // The card renders its own error state, so skip the toast.
      throwOnApiError(error, { toastOnError: false });
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
    onSuccess: async (revoked, { token }) => {
      if (!revoked) return;
      toast.success("Session revoked");
      // Drop the row up front: the refetch below can fail, and the card keeps
      // its last good list on a refetch failure, which would otherwise leave a
      // session we just told the user was revoked still showing as signed in.
      queryClient.setQueryData(
        authQueryKeys.sessions(),
        (current: { token: string }[] | undefined) =>
          current?.filter((session) => session.token !== token),
      );
      await queryClient.invalidateQueries({
        queryKey: authQueryKeys.sessions(),
      });
    },
  });
}

function isSessionNotFreshError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "SESSION_NOT_FRESH"
  );
}
