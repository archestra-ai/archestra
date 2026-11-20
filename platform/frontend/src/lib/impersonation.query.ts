import { archestraApiSdk } from "@archestra/shared";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { authQueryKeys, useHasPermissions } from "@/lib/auth/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useDisableImpersonation } from "@/lib/config/config.query";
import { impersonationEndedNotice } from "@/lib/impersonation-ended-notice";
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

/**
 * How long before an impersonated session expires the app returns to the
 * impersonator's own session. The session has a fixed length and cannot be
 * extended; once it has expired there is no way back but signing in again,
 * so the app leaves while "Return to admin" still works. Two minutes cover
 * the once-a-minute timers of a background tab.
 */
export const IMPERSONATION_RETURN_MARGIN_MS = 2 * 60 * 1000;

/**
 * Return to the impersonator's own session. `"expiring"` is the app doing
 * so by itself, shortly before the impersonated session runs out.
 */
export function useStopImpersonating() {
  const queryClient = useQueryClient();
  return useMutation({
    // biome-ignore lint/suspicious/noConfusingVoidType: void lets callers pass nothing
    mutationFn: async (_reason: "expiring" | void) => {
      const result = await authClient.$fetch("/admin/stop-impersonating", {
        method: "POST",
        // An explicit JSON body. The OAuth client plugin rewrites the body
        // of every POST sent from a page whose address has a query string;
        // with none to start from, the rewritten one goes out without a
        // JSON content type and the server refuses it (415).
        body: {},
      });
      if (result.error) {
        throw result.error;
      }
      return result.data;
    },
    onSuccess: (_data, reason) => {
      // Same reasoning as impersonate — full reload restores every query
      // under the admin session and avoids the inverse permission mismatch.
      clearPersistedQueryCache();
      // The reload takes a toast with it, and nobody asked for this return:
      // the reason is kept for the page that loads next.
      if (reason === "expiring") impersonationEndedNotice.remember("returned");
      else toast.success("Returned to admin session");
      window.location.assign("/");
    },
    onError: (error, reason) => {
      // Too late: the session ran out first. The session check finds that
      // and leads to the sign-in page.
      if (reason === "expiring") {
        void queryClient.refetchQueries({ queryKey: authQueryKeys.session() });
        return;
      }
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to return to admin session",
      );
    },
  });
}
