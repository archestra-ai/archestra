import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  batteriesQueryKey,
  batteryMatchesPrefix,
  effectivePolicyQueryKey,
  invalidatePolicyViews,
  policyDeclarationsQueryKey,
} from "@/lib/openappa-policy-views";
import { getApiErrorType, reportApiError, throwOnApiError } from "@/lib/utils";

export type BatteryMatch =
  archestraApiTypes.GetOpenappaBatteryMatchesResponses["200"][number];
export type BatterySummary =
  archestraApiTypes.GetOpenappaBatteriesResponses["200"][number];
export type BatteryInstall = BatterySummary["installs"][number];
export type PolicyDeclarations =
  archestraApiTypes.GetOpenappaPolicyDeclarationsResponses["200"];
export type PolicyBattery = PolicyDeclarations["batteries"][number];
export type EffectivePolicy =
  archestraApiTypes.GetOpenappaEffectivePolicyResponses["200"];

export const batteryMatchesQueryKey = (catalogId: string) => [
  batteryMatchesPrefix,
  catalogId,
];

/**
 * What the organization's policy text declares and what came of it: every
 * included battery with its status, servers and credential rows, the aliases
 * no battery declares, the composition's last error and a held GitHub pull.
 */
export function usePolicyDeclarations() {
  return useQuery({
    queryKey: policyDeclarationsQueryKey,
    queryFn: async () => {
      const { data, error } =
        await archestraApiSdk.getOpenappaPolicyDeclarations();
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
  });
}

/** The composed document the runtime enforces: the root text with its batteries. */
export function useEffectivePolicy(enabled = true) {
  return useQuery({
    queryKey: effectivePolicyQueryKey,
    enabled,
    queryFn: async () => {
      const { data, error } =
        await archestraApiSdk.getOpenappaEffectivePolicy();
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
  });
}

/** Publish a held GitHub pull under the accepting user's permissions. */
export function useAcceptHeldPull() {
  return useBatteryMutation<
    void,
    archestraApiTypes.AcceptHeldAppaGithubPullResponses["200"]
  >(
    async () => settled(await archestraApiSdk.acceptHeldAppaGithubPull()),
    (accepted) =>
      toast.success(
        accepted.droppedBatteries.length > 0
          ? `Repository text accepted. Dropped: ${accepted.droppedBatteries.join(", ")}`
          : "Repository text accepted",
      ),
  );
}

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
      // A battery is off by being absent from the policy, so turning an
      // unattached one off is nothing to write.
      if (!enabled) return null;
      const created = await archestraApiSdk.createOpenappaBatteryInstall({
        body: { batteryName: match.battery, catalogId },
      });
      if (getApiErrorType(created.error) !== "api_conflict_error")
        return settled(created);
      // A concurrent write attached it first: carry the choice over to its row.
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

/**
 * Include a battery for one catalog entry. The body names the package the
 * policy is to spell: an entry already included governs which bytes win, so
 * the caller passes that entry's hash rather than the newest upload's.
 */
export function useCreateBatteryInstall() {
  return useBatteryMutation(
    async (body: archestraApiTypes.CreateOpenappaBatteryInstallData["body"]) =>
      settled(await archestraApiSdk.createOpenappaBatteryInstall({ body })),
    (battery) => toast.success(`Battery "${battery.name}" attached`),
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

/** Packages are deleted by the bytes they hold: a name may have several versions. */
export function useDeleteBatteryPackage() {
  return useBatteryMutation(
    async (contentHash: string) =>
      settled(
        await archestraApiSdk.deleteOpenappaBatteryPackage({
          path: { contentHash },
        }),
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
  if (result.error !== undefined) throw reportApiError(result.error);
  if (result.data === undefined)
    throw new Error("The API answered with neither data nor an error");
  return result.data;
}

/**
 * A write to the policy's declarations. Whatever happened, every view of the
 * policy is refetched so a refused write (the battery got included meanwhile,
 * the text moved under the edit) shows the server's state.
 */
function useBatteryMutation<TInput, TOutput>(
  mutationFn: (input: TInput) => Promise<TOutput>,
  onSuccess?: (data: TOutput, input: TInput) => void,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess,
    onSettled: () => invalidatePolicyViews(client),
  });
}
