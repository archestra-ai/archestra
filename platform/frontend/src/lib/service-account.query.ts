import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { runBulkAction, toBulkOutcome } from "@/lib/bulk-action";
import { handleApiError, throwOnApiError, toApiError } from "./utils";

export type ServiceAccount =
  archestraApiTypes.GetServiceAccountsResponses["200"][number];
export type ServiceAccountDetail =
  archestraApiTypes.GetServiceAccountResponses["200"];
export type ServiceAccountToken = ServiceAccountDetail["tokens"][number];

const {
  bulkDeleteServiceAccounts,
  bulkSetServiceAccountsDisabled,
  createServiceAccount,
  createServiceAccountToken,
  deleteServiceAccount,
  deleteServiceAccountToken,
  getServiceAccount,
  getServiceAccounts,
  updateServiceAccount,
  updateServiceAccountToken,
} = archestraApiSdk;

export function useServiceAccounts(params?: { labels?: string }) {
  const { data: canReadServiceAccounts } = useHasPermissions({
    serviceAccount: ["read"],
  });
  const labels = params?.labels;

  return useQuery({
    queryKey: ["service-accounts", { labels }],
    queryFn: async () => {
      const { data, error } = await getServiceAccounts({
        query: labels ? { labels } : {},
      });
      // Screen renders its own QueryLoadError panel; don't also toast.
      throwOnApiError(error, { toastOnError: false });

      return data ?? [];
    },
    enabled: !!canReadServiceAccounts,
  });
}

export function useServiceAccount(id: string | null) {
  const { data: canReadServiceAccounts } = useHasPermissions({
    serviceAccount: ["read"],
  });

  return useQuery({
    queryKey: ["service-account", id],
    queryFn: async () => {
      if (!id) return null;
      const { data, error } = await getServiceAccount({ path: { id } });
      throwOnApiError(error, { allowNotFound: true });

      return data ?? null;
    },
    enabled: !!id && !!canReadServiceAccounts,
  });
}

export function useCreateServiceAccount() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.CreateServiceAccountData["body"],
    ) => {
      const { data, error } = await createServiceAccount({ body });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }

      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      toast.success("Service account created successfully");
      // Also refreshes the label filter's key/value vocabulary, which a new
      // account's labels may have just extended.
      queryClient.invalidateQueries({ queryKey: ["service-accounts"] });
    },
  });
}

export function useUpdateServiceAccount() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      body,
    }: {
      id: string;
      body: archestraApiTypes.UpdateServiceAccountData["body"];
    }) => {
      const { data, error } = await updateServiceAccount({
        path: { id },
        body,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }

      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      toast.success("Service account updated successfully");
      queryClient.invalidateQueries({ queryKey: ["service-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["service-account", data.id] });
    },
  });
}

export function useDeleteServiceAccount() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await deleteServiceAccount({ path: { id } });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }

      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      toast.success("Service account deleted successfully");
      queryClient.invalidateQueries({ queryKey: ["service-accounts"] });
    },
  });
}

export function useCreateServiceAccountToken() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      body,
    }: {
      id: string;
      body: archestraApiTypes.CreateServiceAccountTokenData["body"];
    }) => {
      const { data, error } = await createServiceAccountToken({
        path: { id },
        body,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }

      return data;
    },
    onSuccess: (data, variables) => {
      if (!data) return;
      toast.success("API key created successfully");
      queryClient.invalidateQueries({ queryKey: ["service-accounts"] });
      queryClient.invalidateQueries({
        queryKey: ["service-account", variables.id],
      });
    },
  });
}

/**
 * Deletes a selection of service accounts in one request. Deliberately not
 * `useDeleteServiceAccount`, which toasts per call and so would fire one toast
 * per row; the batch reports itself once, naming anything that did not go.
 */
export function useBulkDeleteServiceAccounts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (accounts: readonly { id: string; name: string }[]) =>
      bulkDeleteServiceAccounts({
        body: { ids: accounts.map((account) => account.id) },
      }).then(({ data, error }) => {
        throwOnApiError(error, { toastOnError: false });
        return toBulkOutcome(data ?? { succeeded: [], failed: [] });
      }),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["service-accounts"] }),
  });
}

/**
 * Enables or disables a selection of service accounts in one request. Disabling
 * is the reversible way to stop an automation: the keys survive, so turning it
 * back on does not mean reissuing credentials to whatever was using them.
 */
export function useBulkSetServiceAccountsDisabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      accounts,
      disabled,
    }: {
      accounts: readonly { id: string; name: string }[];
      disabled: boolean;
    }) =>
      bulkSetServiceAccountsDisabled({
        body: { ids: accounts.map((account) => account.id), disabled },
      }).then(({ data, error }) => {
        throwOnApiError(error, { toastOnError: false });
        return toBulkOutcome(data ?? { succeeded: [], failed: [] });
      }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["service-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["service-account"] });
    },
  });
}

export function useDeleteServiceAccountToken() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, tokenId }: { id: string; tokenId: string }) => {
      const { data, error } = await deleteServiceAccountToken({
        path: { id, tokenId },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }

      return data;
    },
    onSuccess: (data, variables) => {
      if (!data) return;
      toast.success("API key deleted successfully");
      queryClient.invalidateQueries({ queryKey: ["service-accounts"] });
      queryClient.invalidateQueries({
        queryKey: ["service-account", variables.id],
      });
    },
  });
}

/**
 * Applies one action to a selection of this account's keys.
 *
 * There is no bulk key endpoint, so this fans out over the per-key routes with
 * the shared client-side runner. It deliberately calls the SDK rather than the
 * single-key hooks above: those toast per call, which for a ten-key revoke
 * would stack ten toasts instead of the one summary `reportBulkOutcome` gives.
 */
export function useBulkServiceAccountTokenAction() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      tokens,
      action,
    }: {
      id: string;
      tokens: readonly ServiceAccountToken[];
      action: { type: "delete" } | { type: "setDisabled"; disabled: boolean };
    }) =>
      runBulkAction({
        items: tokens,
        describe: (token) => token.name,
        run: async (token) => {
          const { error } =
            action.type === "delete"
              ? await deleteServiceAccountToken({
                  path: { id, tokenId: token.id },
                })
              : await updateServiceAccountToken({
                  path: { id, tokenId: token.id },
                  body: { disabled: action.disabled },
                });
          throwOnApiError(error, { toastOnError: false });
        },
      }),
    onSettled: (_data, _error, variables) => {
      queryClient.invalidateQueries({ queryKey: ["service-accounts"] });
      queryClient.invalidateQueries({
        queryKey: ["service-account", variables.id],
      });
    },
  });
}

export function useUpdateServiceAccountToken() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      tokenId,
      body,
    }: {
      id: string;
      tokenId: string;
      body: archestraApiTypes.UpdateServiceAccountTokenData["body"];
    }) => {
      const { data, error } = await updateServiceAccountToken({
        path: { id, tokenId },
        body,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }

      return data;
    },
    onSuccess: (data, variables) => {
      if (!data) return;
      toast.success("API key updated successfully");
      queryClient.invalidateQueries({ queryKey: ["service-accounts"] });
      queryClient.invalidateQueries({
        queryKey: ["service-account", variables.id],
      });
    },
  });
}
