// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { runBulkAction } from "./bulk-action";
import { handleApiError, throwOnApiError, toApiError } from "./utils/api";

/**
 * What a set of federated credentials lets a workload sign in as: a service
 * account (its tokens are exchanged at the workload identity endpoint) or an
 * OAuth client (its tokens stand in for the client secret).
 */
export type FederatedCredentialOwner =
  | { kind: "serviceAccount"; id: string }
  | { kind: "oauthClient"; id: string; clientId: string };

export type FederatedCredential = Omit<
  archestraApiTypes.GetServiceAccountFederatedCredentialsResponses["200"][number],
  "serviceAccountId"
>;
export type FederatedCredentialBody =
  archestraApiTypes.CreateServiceAccountFederatedCredentialData["body"];

const {
  createOauthClientFederatedCredential,
  createServiceAccountFederatedCredential,
  deleteOauthClientFederatedCredential,
  deleteServiceAccountFederatedCredential,
  getOauthClientFederatedCredentials,
  getServiceAccountFederatedCredentials,
  updateOauthClientFederatedCredential,
  updateServiceAccountFederatedCredential,
} = archestraApiSdk;

export function useFederatedCredentials(owner: FederatedCredentialOwner) {
  return useQuery({
    queryKey: federatedCredentialsKey(owner),
    queryFn: async (): Promise<FederatedCredential[]> => {
      const path = { id: owner.id };
      const { data, error } =
        owner.kind === "serviceAccount"
          ? await getServiceAccountFederatedCredentials({ path })
          : await getOauthClientFederatedCredentials({ path });
      // The tab renders its own QueryLoadError panel; don't also toast.
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
  });
}

export function useSaveFederatedCredential(owner: FederatedCredentialOwner) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      credentialId,
      body,
    }: {
      /** Absent to create one. */
      credentialId?: string;
      body: FederatedCredentialBody;
    }): Promise<FederatedCredential | undefined> => {
      const { data, error } = await saveRequest({ owner, credentialId, body });
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
      invalidate(queryClient, owner);
    },
  });
}

export function useDeleteFederatedCredential(owner: FederatedCredentialOwner) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (credentialId: string) => {
      const { data, error } = await deleteRequest(owner, credentialId);
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      toast.success("Federated credential deleted");
      invalidate(queryClient, owner);
    },
  });
}

/**
 * Deletes several credentials of one owner. Reports one outcome for the whole
 * selection (the caller toasts it), not a toast per credential.
 */
export function useBulkDeleteFederatedCredentials(
  owner: FederatedCredentialOwner,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (credentials: readonly FederatedCredential[]) =>
      runBulkAction({
        items: credentials,
        describe: (credential) => credential.name,
        run: async (credential) => {
          const { error } = await deleteRequest(owner, credential.id);
          if (error) throw toApiError(error);
        },
      }),
    onSettled: () => invalidate(queryClient, owner),
  });
}

// === Internal helpers

function saveRequest(params: {
  owner: FederatedCredentialOwner;
  credentialId?: string;
  body: FederatedCredentialBody;
}) {
  const { owner, credentialId, body } = params;
  if (owner.kind === "serviceAccount")
    return credentialId
      ? updateServiceAccountFederatedCredential({
          path: { id: owner.id, credentialId },
          body,
        })
      : createServiceAccountFederatedCredential({
          path: { id: owner.id },
          body,
        });
  return credentialId
    ? updateOauthClientFederatedCredential({
        path: { id: owner.id, credentialId },
        body,
      })
    : createOauthClientFederatedCredential({ path: { id: owner.id }, body });
}

function deleteRequest(owner: FederatedCredentialOwner, credentialId: string) {
  const path = { id: owner.id, credentialId };
  return owner.kind === "serviceAccount"
    ? deleteServiceAccountFederatedCredential({ path })
    : deleteOauthClientFederatedCredential({ path });
}

function federatedCredentialsKey(owner: FederatedCredentialOwner) {
  return owner.kind === "serviceAccount"
    ? ["service-account", owner.id, "federated-credentials"]
    : ["oauth-clients", "federated-credentials", owner.id];
}

/** A service account's health counts its credentials, so it refreshes too. */
function invalidate(
  queryClient: ReturnType<typeof useQueryClient>,
  owner: FederatedCredentialOwner,
) {
  queryClient.invalidateQueries({ queryKey: federatedCredentialsKey(owner) });
  if (owner.kind === "serviceAccount") {
    queryClient.invalidateQueries({ queryKey: ["service-accounts"] });
    queryClient.invalidateQueries({
      queryKey: ["service-account", owner.id],
    });
  }
}
