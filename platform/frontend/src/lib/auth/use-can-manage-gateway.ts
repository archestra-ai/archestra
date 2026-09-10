// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { archestraApiTypes } from "@archestra/shared";
import { useHasPermissions } from "@/lib/auth/auth.query";

type Gateway = archestraApiTypes.GetAgentResponses["200"] | null | undefined;

export function useCanManageGateway(gateway: Gateway): {
  canManage: boolean;
  isLoading: boolean;
} {
  const permission = useHasPermissions(
    { mcpGateway: ["update"] },
    gateway?.id ?? "",
  );
  return {
    canManage: !!gateway && permission.data,
    isLoading: permission.isLoading,
  };
}
