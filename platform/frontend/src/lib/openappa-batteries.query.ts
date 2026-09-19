import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils";

export type BatteryMatch =
  archestraApiTypes.GetOpenappaBatteryMatchesResponses["200"][number];

export const batteryMatchesQueryKey = (catalogId: string) => [
  "openappa-battery-matches",
  catalogId,
];

/** The guardrails batteries a catalog entry stands for, with their installs. */
export function useBatteryMatches(catalogId: string, enabled: boolean) {
  return useQuery({
    queryKey: batteryMatchesQueryKey(catalogId),
    enabled,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getOpenappaBatteryMatches({
        query: { catalogId },
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
  });
}

/** Turns a matched battery on or off for a catalog entry, installing it on first use. */
export function useSetBatteryEnabled(catalogId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (params: { match: BatteryMatch; enabled: boolean }) => {
      const { match, enabled } = params;
      const { data, error } = match.install
        ? await archestraApiSdk.updateOpenappaBatteryInstall({
            path: { id: match.install.id },
            body: { enabled },
          })
        : await archestraApiSdk.createOpenappaBatteryInstall({
            body: { batteryName: match.battery, catalogId, enabled },
          });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    // A refused write (the battery got installed meanwhile, another server
    // owns its helpers) leaves the checkbox showing what the server holds.
    onSettled: () =>
      client.invalidateQueries({ queryKey: batteryMatchesQueryKey(catalogId) }),
  });
}
