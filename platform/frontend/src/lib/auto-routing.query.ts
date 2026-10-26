import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils/api";

const {
  getAutoRoutingSettings,
  updateAutoRoutingSettings,
  getAutoRoutingPlans,
  getAutoRoutingPlan,
  replanAutoRouting,
  previewAutoRouting,
} = archestraApiSdk;

export type AutoRoutingSettings =
  archestraApiTypes.GetAutoRoutingSettingsResponses["200"];
export type AutoRoutingSettingsUpdate =
  archestraApiTypes.UpdateAutoRoutingSettingsData["body"];
export type AutoRoutingPlanSummary =
  archestraApiTypes.GetAutoRoutingPlansResponses["200"][number];
export type AutoRoutingPlanDetail =
  archestraApiTypes.GetAutoRoutingPlanResponses["200"];
export type AutoRoutingPreviewBody =
  archestraApiTypes.PreviewAutoRoutingData["body"];
export type AutoRoutingPreview =
  archestraApiTypes.PreviewAutoRoutingResponses["200"];

const autoRoutingKeys = {
  all: ["auto-routing"] as const,
  settings: () => [...autoRoutingKeys.all, "settings"] as const,
  plans: () => [...autoRoutingKeys.all, "plans"] as const,
  planDetails: () => [...autoRoutingKeys.all, "plan"] as const,
  plan: (id: string | null) => [...autoRoutingKeys.planDetails(), id] as const,
};

const REPLAN_POLL_INTERVAL_MS = 3_000;

export function isReplanPending(settings: AutoRoutingSettings): boolean {
  return settings.generation > settings.plannedGeneration;
}

export function useAutoRoutingSettings() {
  return useQuery({
    queryKey: autoRoutingKeys.settings(),
    queryFn: async ({ client }) => {
      const { data, error } = await getAutoRoutingSettings();
      throwOnApiError(error, { toastOnError: false });
      const previous = client.getQueryData<AutoRoutingSettings | null>(
        autoRoutingKeys.settings(),
      );
      if (
        previous &&
        data &&
        previous.plannedGeneration !== data.plannedGeneration
      ) {
        // A fit finished: plans gained a row and the old one changed status.
        void client.invalidateQueries({ queryKey: autoRoutingKeys.plans() });
        void client.invalidateQueries({
          queryKey: autoRoutingKeys.planDetails(),
        });
      }
      return data ?? null;
    },
    refetchInterval: ({ state }) =>
      state.data && isReplanPending(state.data)
        ? REPLAN_POLL_INTERVAL_MS
        : false,
  });
}

export function useAutoRoutingPlans() {
  return useQuery({
    queryKey: autoRoutingKeys.plans(),
    queryFn: async () => {
      const { data, error } = await getAutoRoutingPlans({
        query: { limit: 50 },
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
  });
}

export function useAutoRoutingPlan(id: string | null) {
  return useQuery({
    queryKey: autoRoutingKeys.plan(id),
    queryFn: async () => {
      if (!id) return null;
      const { data, error } = await getAutoRoutingPlan({ path: { id } });
      throwOnApiError(error, { allowNotFound: true });
      return data ?? null;
    },
    enabled: !!id,
  });
}

export function useUpdateAutoRoutingSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: AutoRoutingSettingsUpdate) => {
      const { data, error } = await updateAutoRoutingSettings({ body });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: autoRoutingKeys.all });
      toast.success("Auto routing settings saved");
    },
  });
}

export function useReplanAutoRouting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await replanAutoRouting();
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: autoRoutingKeys.all });
      toast.success("Re-plan requested");
    },
  });
}

export function usePreviewAutoRouting() {
  return useMutation({
    mutationFn: async (body: AutoRoutingPreviewBody) => {
      const { data, error } = await previewAutoRouting({ body });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
  });
}
