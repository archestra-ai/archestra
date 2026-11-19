// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { runBulkAction } from "./bulk-action";
import { handleApiError, throwOnApiError, toApiError } from "./utils";

export type FederatedCredential =
  archestraApiTypes.GetServiceAccountFederatedCredentialsResponses["200"][number];
export type FederatedCredentialBody =
  archestraApiTypes.CreateServiceAccountFederatedCredentialData["body"];

const {
  createServiceAccountFederatedCredential,
  deleteServiceAccountFederatedCredential,
  getServiceAccountFederatedCredentials,
  updateServiceAccountFederatedCredential,
} = archestraApiSdk;

export function useFederatedCredentials(serviceAccountId: string) {
  return useQuery({
    queryKey: federatedCredentialsKey(serviceAccountId),
    queryFn: async () => {
      const { data, error } = await getServiceAccountFederatedCredentials({
        path: { id: serviceAccountId },
      });
      // The tab renders its own QueryLoadError panel; don't also toast.
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
  });
}

export function useSaveFederatedCredential(serviceAccountId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      credentialId,
      body,
    }: {
      /** Absent to create one. */
      credentialId?: string;
      body: FederatedCredentialBody;
    }) => {
      const { data, error } = credentialId
        ? await updateServiceAccountFederatedCredential({
            path: { id: serviceAccountId, credentialId },
            body,
          })
        : await createServiceAccountFederatedCredential({
            path: { id: serviceAccountId },
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
      toast.success(
        variables.credentialId
          ? "Federated credential updated"
          : "Federated credential created",
      );
      invalidate(queryClient, serviceAccountId);
    },
  });
}

export function useDeleteFederatedCredential(serviceAccountId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (credentialId: string) => {
      const { data, error } = await deleteServiceAccountFederatedCredential({
        path: { id: serviceAccountId, credentialId },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      toast.success("Federated credential deleted");
      invalidate(queryClient, serviceAccountId);
    },
  });
}

/**
 * Deletes several credentials of one account. Reports one outcome for the
 * whole selection (the caller toasts it), not a toast per credential.
 */
export function useBulkDeleteFederatedCredentials(serviceAccountId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (credentials: readonly FederatedCredential[]) =>
      runBulkAction({
        items: credentials,
        describe: (credential) => credential.name,
        run: async (credential) => {
          const { error } = await deleteServiceAccountFederatedCredential({
            path: { id: serviceAccountId, credentialId: credential.id },
          });
          if (error) throw toApiError(error);
        },
      }),
    onSettled: () => invalidate(queryClient, serviceAccountId),
  });
}

// === Internal helpers

function federatedCredentialsKey(serviceAccountId: string) {
  return ["service-account", serviceAccountId, "federated-credentials"];
}

/** The account's health counts its credentials, so it refreshes too. */
function invalidate(
  queryClient: ReturnType<typeof useQueryClient>,
  serviceAccountId: string,
) {
  queryClient.invalidateQueries({
    queryKey: federatedCredentialsKey(serviceAccountId),
  });
  queryClient.invalidateQueries({ queryKey: ["service-accounts"] });
  queryClient.invalidateQueries({
    queryKey: ["service-account", serviceAccountId],
  });
}
