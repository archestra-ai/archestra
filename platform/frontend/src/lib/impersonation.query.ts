import { archestraApiSdk } from "@shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useIsAuthenticated } from "@/lib/auth/auth.hook";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { handleApiError } from "@/lib/utils";

export const impersonationKeys = {
  all: ["impersonation"] as const,
  candidates: () => [...impersonationKeys.all, "candidates"] as const,
};

export function useImpersonationCandidates() {
  const isAuthenticated = useIsAuthenticated();
  const { data: canManage } = useHasPermissions({ member: ["update"] });

  return useQuery({
    queryKey: impersonationKeys.candidates(),
    queryFn: async () => {
      const response = await archestraApiSdk.getImpersonableUsers();
      if (response.error) {
        handleApiError(response.error);
        return [];
      }
      return response.data ?? [];
    },
    enabled: isAuthenticated && !!canManage,
    retry: false,
    throwOnError: false,
  });
}

export function useImpersonateUser() {
  return useMutation({
    mutationFn: async (userId: string) => {
      const result = await authClient.admin.impersonateUser({ userId });
      if (result.error) {
        throw result.error;
      }
      return result.data;
    },
    onSuccess: () => {
      // Hard reload to "/" — the impersonated session likely cannot access the
      // page the admin started from (e.g. /settings/roles requires ac:read).
      // A full-document navigation also drops every cached admin query, so we
      // never render with a mix of admin permissions and member data.
      toast.success("Switched to impersonated session");
      window.location.assign("/");
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to start impersonation",
      );
    },
  });
}

export function useStopImpersonating() {
  return useMutation({
    mutationFn: async () => {
      const result = await authClient.admin.stopImpersonating();
      if (result.error) {
        throw result.error;
      }
      return result.data;
    },
    onSuccess: () => {
      // Same reasoning as impersonate — full reload restores every query
      // under the admin session and avoids the inverse permission mismatch.
      toast.success("Returned to admin session");
      window.location.assign("/");
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to return to admin session",
      );
    },
  });
}
