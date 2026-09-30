import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils/api";

export type OpenAppaYell = archestraApiTypes.GetOpenAppaYellResponses[200];
export function useOpenAppaYells(
  query: archestraApiTypes.GetOpenAppaYellsData["query"],
  enabled = true,
) {
  return useQuery({
    queryKey: ["openappa-yells", "list", query],
    enabled,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getOpenAppaYells({ query });
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
  });
}
export function useOpenAppaYellsSummary(enabled = true) {
  return useQuery({
    queryKey: ["openappa-yells", "summary"],
    enabled,
    refetchInterval: 30000,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getOpenAppaYellsSummary();
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
  });
}
export function useResolveOpenAppaYell() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, resolved }: { id: string; resolved: boolean }) => {
      const { data, error } = await archestraApiSdk.updateOpenAppaYell({
        path: { id },
        body: { resolved },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["openappa-yells"] }),
  });
}
