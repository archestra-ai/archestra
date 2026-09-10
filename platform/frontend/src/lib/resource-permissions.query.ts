// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  archestraApiSdk,
  type archestraApiTypes,
  type ScopedResource,
} from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, throwOnApiError, toApiError } from "./utils";

export type ResourcePermissions =
  archestraApiTypes.GetResourcePermissionsResponses["200"];
export type PermissionRecipient =
  archestraApiTypes.SearchResourcePermissionSubjectsResponses["200"][number];

export function useResourcePermissions(
  resource: ScopedResource,
  scope: string,
) {
  return useQuery({
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
  scope: string;
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
        await archestraApiSdk.searchResourcePermissionSubjects({
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
