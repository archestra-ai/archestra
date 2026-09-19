import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getApiErrorType,
  handleApiError,
  throwOnApiError,
  toApiError,
} from "@/lib/utils";

export type BatteryMatch =
  archestraApiTypes.GetOpenappaBatteryMatchesResponses["200"][number];
export type BatterySummary =
  archestraApiTypes.GetOpenappaBatteriesResponses["200"][number];
export type BatteryInstall = BatterySummary["installs"][number];

const batteriesQueryKey = ["openappa-batteries"];
const batteryMatchesPrefix = "openappa-battery-matches";
export const batteryMatchesQueryKey = (catalogId: string) => [
  batteryMatchesPrefix,
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
  return useBatteryMutation(
    async (params: { match: BatteryMatch; enabled: boolean }) => {
      const { match, enabled } = params;
      if (match.install) return setInstallEnabled(match.install.id, enabled);
      const created = await archestraApiSdk.createOpenappaBatteryInstall({
        body: { batteryName: match.battery, catalogId, enabled },
      });
      if (getApiErrorType(created.error) !== "api_conflict_error")
        return settled(created);
      // A tool sync attached the battery first: carry the choice over to its install.
      const matches = settled(
        await archestraApiSdk.getOpenappaBatteryMatches({
          query: { catalogId },
        }),
      );
      const install = matches.find(
        (fresh) => fresh.battery === match.battery,
      )?.install;
      return install
        ? setInstallEnabled(install.id, enabled)
        : settled(created);
    },
  );
}

export function useUpdateBatteryInstall() {
  return useBatteryMutation(
    async (params: {
      id: string;
      body: archestraApiTypes.UpdateOpenappaBatteryInstallData["body"];
    }) =>
      settled(
        await archestraApiSdk.updateOpenappaBatteryInstall({
          path: { id: params.id },
          body: params.body,
        }),
      ),
  );
}

export function useDeleteBatteryInstall() {
  return useBatteryMutation(
    async (id: string) =>
      settled(
        await archestraApiSdk.deleteOpenappaBatteryInstall({ path: { id } }),
      ),
    () => toast.success("Battery removed"),
  );
}

export function useUploadBatteryPackage() {
  return useBatteryMutation(
    async (params: {
      name: string;
      files: archestraApiTypes.UploadOpenappaBatteryPackageData["body"]["files"];
    }) =>
      settled(
        await archestraApiSdk.uploadOpenappaBatteryPackage({
          path: { name: params.name },
          body: { files: params.files },
        }),
      ),
    (data) => toast.success(`Battery "${data.name}" uploaded`),
  );
}

export function useDeleteBatteryPackage() {
  return useBatteryMutation(
    async (name: string) =>
      settled(
        await archestraApiSdk.deleteOpenappaBatteryPackage({ path: { name } }),
      ),
    () => toast.success("Battery package deleted"),
  );
}

async function setInstallEnabled(id: string, enabled: boolean) {
  return settled(
    await archestraApiSdk.updateOpenappaBatteryInstall({
      path: { id },
      body: { enabled },
    }),
  );
}

/** The SDK call's data, or its refusal toasted and thrown. */
function settled<T>(result: { data?: T; error?: unknown }): T {
  if (result.error !== undefined) {
    handleApiError(result.error);
    throw toApiError(result.error);
  }
  if (result.data === undefined)
    throw new Error("The API answered with neither data nor an error");
  return result.data;
}

/**
 * A write to an install or package. Whatever happened, the battery list and
 * every catalog entry's matches are refetched so a refused write (the battery
 * got installed meanwhile, another server owns its helpers) shows the server's
 * state.
 */
function useBatteryMutation<TInput, TOutput>(
  mutationFn: (input: TInput) => Promise<TOutput>,
  onSuccess?: (data: TOutput, input: TInput) => void,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess,
    onSettled: () => invalidateBatteries(client),
  });
}

function invalidateBatteries(client: QueryClient) {
  return Promise.all([
    client.invalidateQueries({ queryKey: batteriesQueryKey }),
    client.invalidateQueries({ queryKey: [batteryMatchesPrefix] }),
  ]);
}
