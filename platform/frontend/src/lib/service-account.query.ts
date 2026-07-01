import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { handleApiError, throwOnApiError, toApiError } from "./utils";

export type ServiceAccount =
  archestraApiTypes.GetServiceAccountsResponses["200"][number];
export type ServiceAccountDetail =
  archestraApiTypes.GetServiceAccountResponses["200"];
export type ServiceAccountToken = ServiceAccountDetail["tokens"][number];

const {
  createServiceAccount,
  createServiceAccountToken,
  deleteServiceAccount,
  deleteServiceAccountToken,
  getServiceAccount,
  getServiceAccounts,
  updateServiceAccount,
  updateServiceAccountToken,
} = archestraApiSdk;

export function useServiceAccounts() {
  const { data: canReadServiceAccounts } = useHasPermissions({
    serviceAccount: ["read"],
  });

  return useQuery({
    queryKey: ["service-accounts"],
    queryFn: async () => {
      const { data, error } = await getServiceAccounts();
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
      toast.success("Service account token created successfully");
      queryClient.invalidateQueries({ queryKey: ["service-accounts"] });
      queryClient.invalidateQueries({
        queryKey: ["service-account", variables.id],
      });
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
      toast.success("Service account token deleted successfully");
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
      toast.success("Service account token updated successfully");
      queryClient.invalidateQueries({ queryKey: ["service-accounts"] });
      queryClient.invalidateQueries({
        queryKey: ["service-account", variables.id],
      });
    },
  });
}
