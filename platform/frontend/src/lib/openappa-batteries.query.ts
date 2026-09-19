import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils";

export type BatteryMatch =
  archestraApiTypes.GetOpenappaBatteryMatchesResponses["200"][number];
export type BatterySummary =
  archestraApiTypes.GetOpenappaBatteriesResponses["200"][number];
export type BatteryInstall = BatterySummary["installs"][number];

const batteriesQueryKey = ["openappa-batteries"];
export const batteryMatchesQueryKey = (catalogId: string) => [
  "openappa-battery-matches",
  catalogId,
];

/** Every battery the organization can install, bundled and uploaded, with its installs. */
export function useBatteries() {
  return useQuery({
    queryKey: batteriesQueryKey,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getOpenappaBatteries();
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
  });
}

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
    onSettled: () => invalidateBatteries(client),
  });
}

export function useUpdateBatteryInstall() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      id: string;
      body: archestraApiTypes.UpdateOpenappaBatteryInstallData["body"];
    }) => {
      const { data, error } =
        await archestraApiSdk.updateOpenappaBatteryInstall({
          path: { id: params.id },
          body: params.body,
        });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSettled: () => invalidateBatteries(client),
  });
}

export function useDeleteBatteryInstall() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await archestraApiSdk.deleteOpenappaBatteryInstall({
        path: { id },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
    },
    onSuccess: () => toast.success("Battery removed"),
    onSettled: () => invalidateBatteries(client),
  });
}

export function useUploadBatteryPackage() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      name: string;
      files: archestraApiTypes.UploadOpenappaBatteryPackageData["body"]["files"];
    }) => {
      const { data, error } =
        await archestraApiSdk.uploadOpenappaBatteryPackage({
          path: { name: params.name },
          body: { files: params.files },
        });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: (data) => toast.success(`Battery "${data.name}" uploaded`),
    onSettled: () => invalidateBatteries(client),
  });
}

export function useDeleteBatteryPackage() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const { error } = await archestraApiSdk.deleteOpenappaBatteryPackage({
        path: { name },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
    },
    onSuccess: () => toast.success("Battery package deleted"),
    onSettled: () => invalidateBatteries(client),
  });
}

/** Installs show up in the battery list and in every catalog entry's matches. */
function invalidateBatteries(client: QueryClient) {
  return Promise.all([
    client.invalidateQueries({ queryKey: batteriesQueryKey }),
    client.invalidateQueries({ queryKey: ["openappa-battery-matches"] }),
  ]);
}
