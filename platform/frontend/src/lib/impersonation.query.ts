import { archestraApiSdk } from "@archestra/shared";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useDisableImpersonation } from "@/lib/config/config.query";
import { clearPersistedQueryCache } from "@/lib/query-persistence";
import { throwOnApiError } from "@/lib/utils/api";

// The org-level RBAC permission member:impersonate is the source of truth
// (the backend keeps better-auth's system-level role in lockstep with it),
// so the UI offers impersonation exactly when the permission is held — and
// never when the deployment-level kill switch is on.
export function useCanImpersonate() {
  const disableImpersonation = useDisableImpersonation();
  const { data: hasImpersonatePermission } = useHasPermissions({
    member: ["impersonate"],
  });
  return disableImpersonation === false && !!hasImpersonatePermission;
}

export const impersonationKeys = {
  all: ["impersonation"] as const,
  candidates: () => [...impersonationKeys.all, "candidates"] as const,
};

/** One server-searched page stream of users the caller can impersonate. */
export function useImpersonationCandidatesPage({
  search,
  enabled,
}: {
  search: string;
  enabled: boolean;
}) {
  return useInfiniteQuery({
    queryKey: [...impersonationKeys.candidates(), search],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const { data, error } = await archestraApiSdk.getImpersonableUsers({
        signal,
        query: { search: search || undefined, cursor: pageParam, limit: 20 },
      });
      throwOnApiError(error, { toastOnError: false });
      if (!data) throw new Error("Impersonation candidates are unavailable");
      return data;
    },
    getNextPageParam: (page) => page.pagination.nextCursor ?? undefined,
    enabled,
    retry: false,
  });
}

export function useImpersonateUser() {
  return useMutation({
    mutationFn: async (userId: string) => {
      // By path: the admin plugin's client is not in the bundle.
      const result = await authClient.$fetch("/admin/impersonate-user", {
        method: "POST",
        body: { userId },
      });
      if (result.error) {
        throw result.error;
      }
      return result.data;
    },
    onSuccess: () => {
      // Hard reload to "/" — the impersonated session likely cannot access the
      // page the admin started from (e.g. /settings/roles requires ac:read).
      // Drop the refresh snapshot too, or navigation restores the admin's
      // session and permissions over the newly impersonated session.
      clearPersistedQueryCache();
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
      const result = await authClient.$fetch("/admin/stop-impersonating", {
        method: "POST",
      });
      if (result.error) {
        throw result.error;
      }
      return result.data;
    },
    onSuccess: () => {
      // Same reasoning as impersonate — full reload restores every query
      // under the admin session and avoids the inverse permission mismatch.
      clearPersistedQueryCache();
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
