// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  archestraApiSdk,
  type archestraApiTypes,
  type ResourcePermissionGrant,
  type ScopedResource,
} from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { reportBulkOutcome, runBulkAction } from "./bulk-action";
import { handleApiError, throwOnApiError, toApiError } from "./utils";

export type ResourcePermissions =
  archestraApiTypes.GetResourcePermissionsResponses["200"];
export type PermissionRecipient =
  archestraApiTypes.SearchResourcePermissionSubjectsResponses["200"][number];

export function useResourcePermissions(
  resource: ScopedResource,
  scope: string,
  enabled = true,
) {
  return useQuery({
    enabled,
    queryKey: ["resource-permissions", resource, scope],
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getResourcePermissions({
        path: { resource, scope },
      });
      throwOnApiError(error, { toastOnError: false });
      if (!data) throw new Error("Permissions response is missing");
      return data;
    },
  });
}

export function usePermissionRecipients(params: {
  resource: ScopedResource;
  /** Omit for a resource that has not been created yet. */
  scope?: string;
  query: string;
  enabled: boolean;
}) {
  return useQuery({
    queryKey: [
      "permission-recipients",
      params.resource,
      params.scope,
      params.query,
    ],
    enabled: params.enabled,
    queryFn: async () => {
      const { data, error } =
        params.scope === undefined
          ? await archestraApiSdk.searchInitialPermissionSubjects({
              path: { resource: params.resource },
              query: { query: params.query },
            })
          : await archestraApiSdk.searchResourcePermissionSubjects({
              path: { resource: params.resource, scope: params.scope },
              query: { query: params.query },
            });
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
  });
}

export function useUpdateResourcePermissions(
  resource: ScopedResource,
  scope: string,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.UpdateResourcePermissionsData["body"],
    ) => {
      const { data, error } = await archestraApiSdk.updateResourcePermissions({
        path: { resource, scope },
        body,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      if (!data) throw new Error("Permissions response is missing");
      return data;
    },
    onSuccess: async (data) => {
      client.setQueryData(["resource-permissions", resource, scope], data);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["resource-permissions"] }),
        client.invalidateQueries({ queryKey: ["mcp-catalog"] }),
        client.invalidateQueries({ queryKey: ["scoped-capabilities"] }),
        client.invalidateQueries({ queryKey: ["skills"] }),
        client.invalidateQueries({ queryKey: ["apps"] }),
        client.invalidateQueries({ queryKey: ["agents"] }),
        client.invalidateQueries({ queryKey: ["conversation"] }),
        client.invalidateQueries({ queryKey: ["conversations"] }),
        client.invalidateQueries({ queryKey: ["agent-runs"] }),
        client.invalidateQueries({ queryKey: ["llm-models"] }),
        client.invalidateQueries({ queryKey: ["models-with-api-keys"] }),
      ]);
      toast.success("Permissions saved");
    },
    onError: async () => {
      await client.invalidateQueries({
        queryKey: ["resource-permissions", resource, scope],
      });
    },
  });
}

/** Merge additions against each current revision, preserving stronger access. */
export function useAddBulkResourceAccess(resource: ScopedResource) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      items,
      grants,
    }: {
      items: readonly { id: string; name: string }[];
      grants: ResourcePermissionGrant[];
    }) =>
      runBulkAction({
        items,
        describe: (item) => item.name,
        run: async (item) => {
          const { data: policy, error } =
            await archestraApiSdk.getResourcePermissions({
              path: { resource, scope: item.id },
            });
          throwOnApiError(error, { toastOnError: false });
          if (!policy) throw new Error("Permissions response is missing");
          const merged = policy.grants.map(({ subject, actions }) => ({
            subject,
            actions: [...actions],
          }));
          for (const grant of grants) {
            const existing = merged.find(
              (entry) =>
                entry.subject.type === grant.subject.type &&
                entry.subject.id === grant.subject.id,
            );
            if (existing)
              existing.actions = [
                ...new Set([...existing.actions, ...grant.actions]),
              ];
            else
              merged.push({
                subject: grant.subject,
                actions: [...grant.actions],
              });
          }
          const result = await archestraApiSdk.updateResourcePermissions({
            path: { resource, scope: item.id },
            body: { revision: policy.revision, grants: merged },
          });
          throwOnApiError(result.error, { toastOnError: false });
        },
      }),
    onSuccess: async (outcome) => {
      await client.invalidateQueries();
      reportBulkOutcome({
        outcome,
        verb: "Added access to",
        failureVerb: "update permissions for",
        noun: "resource",
      });
    },
  });
}
