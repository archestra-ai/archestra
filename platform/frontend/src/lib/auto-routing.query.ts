import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { getApiErrorType, throwOnApiError } from "@/lib/utils/api";

const {
  getAutoRoutingSettings,
  updateAutoRoutingSettings,
  getAutoRoutingPlans,
  getAutoRoutingPlan,
  replanAutoRouting,
  previewAutoRouting,
  simulateAutoRouting,
  getAutoRoutingBackfill,
  scanAutoRoutingBackfill,
  scoreAutoRoutingBackfill,
  cancelAutoRoutingBackfill,
} = archestraApiSdk;

export type AutoRoutingSettings =
  archestraApiTypes.GetAutoRoutingSettingsResponses["200"];
type AutoRoutingSettingsChange =
  archestraApiTypes.UpdateAutoRoutingSettingsResponses["200"];
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
type AutoRoutingSimulateBody =
  archestraApiTypes.SimulateAutoRoutingData["body"];
export type AutoRoutingSimulation =
  archestraApiTypes.SimulateAutoRoutingResponses["200"];
export type AutoRoutingBackfillState =
  archestraApiTypes.GetAutoRoutingBackfillResponses["200"];
type AutoRoutingScoreBackfillBody =
  archestraApiTypes.ScoreAutoRoutingBackfillData["body"];
export type SimulatedTraffic = Extract<
  AutoRoutingSimulation,
  { status: "feasible" }
>["baseline"];

const autoRoutingKeys = {
  all: ["auto-routing"] as const,
  settings: () => [...autoRoutingKeys.all, "settings"] as const,
  plans: () => [...autoRoutingKeys.all, "plans"] as const,
  planDetails: () => [...autoRoutingKeys.all, "plan"] as const,
  plan: (id: string | null) => [...autoRoutingKeys.planDetails(), id] as const,
  simulations: () => [...autoRoutingKeys.all, "simulate"] as const,
  simulation: (body: AutoRoutingSimulateBody | null) =>
    [...autoRoutingKeys.simulations(), body] as const,
  backfill: () => [...autoRoutingKeys.all, "backfill"] as const,
};

export function useAutoRoutingSettings() {
  return useQuery({
    queryKey: autoRoutingKeys.settings(),
    queryFn: async () => {
      const { data, error } = await getAutoRoutingSettings();
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
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
      throwOnApiError(error);
      return data;
    },
    onSuccess: (data) => applyFit(queryClient, data),
  });
}

export function useReplanAutoRouting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await replanAutoRouting();
      throwOnApiError(error);
      return data;
    },
    onSuccess: (data) => applyFit(queryClient, data),
  });
}

/** The response already carries the fit's outcome; only the plan lists need refetching. */
async function applyFit(
  queryClient: QueryClient,
  data: AutoRoutingSettingsChange | undefined,
) {
  if (!data) return;
  queryClient.setQueryData(autoRoutingKeys.settings(), data);
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: autoRoutingKeys.plans() }),
    queryClient.invalidateQueries({ queryKey: autoRoutingKeys.planDetails() }),
    queryClient.invalidateQueries({ queryKey: autoRoutingKeys.simulations() }),
  ]);
  switch (data.fit?.status) {
    case undefined:
      toast.success("Auto routing settings saved");
      break;
    case "active":
      toast.success("New plan is active");
      break;
    case "unchanged":
      toast.success("Plan is up to date");
      break;
    case "cold_start":
      toast.success("Saved; collecting sessions before the first plan");
      break;
    case "failed":
      toast.error("Plan fit failed");
      break;
  }
}

export function usePreviewAutoRouting() {
  return useMutation({
    mutationFn: async (body: AutoRoutingPreviewBody) => {
      const { data, error } = await previewAutoRouting({ body });
      throwOnApiError(error);
      return data;
    },
  });
}

/**
 * A fit at `body`'s budget and traffic that publishes nothing; idle while
 * `body` is null. The backend runs one simulation per organization at a time,
 * so one refused while an abandoned earlier one finishes is retried.
 */
export function useSimulateAutoRouting(body: AutoRoutingSimulateBody | null) {
  return useQuery({
    queryKey: autoRoutingKeys.simulation(body),
    queryFn: async () => {
      if (!body) return null;
      const { data, error } = await simulateAutoRouting({ body });
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
    enabled: body !== null,
    retry: (failures, error) =>
      failures < SIMULATION_RETRIES &&
      getApiErrorType(error.cause) === "api_rate_limit_error",
    retryDelay: SIMULATION_RETRY_DELAY_MS,
  });
}

const SIMULATION_RETRIES = 10;
const SIMULATION_RETRY_DELAY_MS = 1000;

const BACKFILL_POLL_MS = 5000;

/** The organization's latest historical backfill, polled while it runs. */
export function useAutoRoutingBackfill() {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: autoRoutingKeys.backfill(),
    queryFn: async () => {
      const { data, error } = await getAutoRoutingBackfill();
      throwOnApiError(error, { toastOnError: false });
      const previous = queryClient.getQueryData<AutoRoutingBackfillState>(
        autoRoutingKeys.backfill(),
      );
      // A finished backfill bumps the generation and re-fits.
      if (
        previous?.backfill?.status === "running" &&
        data?.backfill?.status !== "running"
      ) {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: autoRoutingKeys.settings(),
          }),
          queryClient.invalidateQueries({ queryKey: autoRoutingKeys.plans() }),
        ]);
      }
      return data ?? null;
    },
    refetchInterval: (query) =>
      query.state.data?.backfill?.status === "running"
        ? BACKFILL_POLL_MS
        : false,
  });
}

export function useScanAutoRoutingBackfill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await scanAutoRoutingBackfill();
      throwOnApiError(error);
      return data;
    },
    onSuccess: (data) =>
      queryClient.setQueryData(autoRoutingKeys.backfill(), data),
  });
}

export function useScoreAutoRoutingBackfill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: AutoRoutingScoreBackfillBody) => {
      const { data, error } = await scoreAutoRoutingBackfill({ body });
      throwOnApiError(error);
      return data;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(autoRoutingKeys.backfill(), data);
      toast.success("Scoring past sessions");
    },
  });
}

export function useCancelAutoRoutingBackfill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await cancelAutoRoutingBackfill();
      throwOnApiError(error);
      return data;
    },
    onSuccess: (data) =>
      queryClient.setQueryData(autoRoutingKeys.backfill(), data),
  });
}
