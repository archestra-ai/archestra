import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
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
  return useQuery(policyDeclarationsQuery);
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
export function useBatteries(enabled = true) {
  return useQuery({ ...batteriesQuery, enabled });
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
  return useBatteryMutation(
    async (params: { match: BatteryMatch; enabled: boolean }) => {
      const { match, enabled } = params;
      if (match.install) return setInstallEnabled(match.install.id, enabled);
      // A battery is off by being absent from the policy, so turning an
      // unattached one off is nothing to write.
      if (!enabled) return null;
      const created = await createInstall(client, {
        batteryName: match.battery,
        catalogId,
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

/** Include a battery for a catalog entry, spelling the package the policy governs. */
export function useCreateBatteryInstall() {
  const client = useQueryClient();
  return useBatteryMutation(
    async (params: { batteryName: string; catalogId: string }) =>
      settled(await createInstall(client, params)),
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

/** Take a battery out of the policy text, install rows or not. */
export function useRemoveBatteryInclude() {
  return useBatteryMutation(
    async (name: string) =>
      settled(
        await archestraApiSdk.deleteOpenappaBatteryInclude({ path: { name } }),
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

/**
 * The one create call: a battery is included once, so a second server joining
 * one the policy already includes has to name that entry's package — the
 * server refuses any other spelling. The package is read at write time, always
 * from the server, so a policy that moved since the render still lands; the
 * answer goes through the query cache so the page shows what was written to.
 */
async function createInstall(
  client: QueryClient,
  params: { batteryName: string; catalogId: string },
) {
  const packageHash = await includedPackageHash(client, params.batteryName);
  return archestraApiSdk.createOpenappaBatteryInstall({
    body: {
      ...params,
      ...(packageHash === null ? {} : { packageHash }),
    },
  });
}

/** The included entry's package, else the newest upload's, else none (bundled). */
async function includedPackageHash(
  client: QueryClient,
  name: string,
): Promise<string | null> {
  const declarations = await client.fetchQuery({
    ...policyDeclarationsQuery,
    staleTime: 0,
  });
  const included = declarations?.batteries.find(
    (battery) => battery.name === name,
  );
  if (included) return included.packageHash;
  const batteries = await client.fetchQuery({
    ...batteriesQuery,
    staleTime: 0,
  });
  const battery = batteries.find((candidate) => candidate.name === name);
  return battery?.source === "upload" ? battery.contentHash : null;
}

const policyDeclarationsQuery = {
  queryKey: policyDeclarationsQueryKey,
  queryFn: async () => {
    const { data, error } =
      await archestraApiSdk.getOpenappaPolicyDeclarations();
    throwOnApiError(error, { toastOnError: false });
    return data ?? null;
  },
};

const batteriesQuery = {
  queryKey: batteriesQueryKey,
  queryFn: async () => {
    const { data, error } = await archestraApiSdk.getOpenappaBatteries();
    throwOnApiError(error, { toastOnError: false });
    return data ?? [];
  },
};

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
