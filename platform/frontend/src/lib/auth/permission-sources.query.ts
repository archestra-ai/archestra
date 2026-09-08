// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { archestraApiSdk } from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { throwOnApiError } from "@/lib/utils";
import { authQueryKeys } from "./auth.query";

export function usePermissionSources(params?: { enabled?: boolean }) {
  return useQuery({
    enabled: params?.enabled,
    queryKey: [...authQueryKeys.all, "permissionSources"],
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getUserPermissionSources();
      throwOnApiError(error);
      return data ?? [];
    },
  });
}
