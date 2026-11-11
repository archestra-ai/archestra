import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createContext, useContext } from "react";
import { toast } from "sonner";
import { organizationKeys } from "@/lib/organization.query";
import { getApiErrorType, throwOnApiError } from "@/lib/utils/api";

const {
  getAutoRoutingState,
  updateAutoRoutingState,
  getAutoRouters,
  getAvailableAutoRouters,
  createAutoRouter,
  updateAutoRouter,
  deleteAutoRouter,
  getAutoRoutingUsage,
  getAutoRoutingPlan,
  simulateAutoRouting,
  getAutoRoutingBackfill,
  scanAutoRoutingBackfill,
  scoreAutoRoutingBackfill,
  cancelAutoRoutingBackfill,
} = archestraApiSdk;

export type AutoRoutingState =
  archestraApiTypes.GetAutoRoutingStateResponses["200"];
export type AutoRouter =
  archestraApiTypes.GetAutoRoutersResponses["200"][number];
type AutoRouterChange = archestraApiTypes.UpdateAutoRouterResponses["200"];
export type AvailableAutoRouter =
  archestraApiTypes.GetAvailableAutoRoutersResponses["200"][number];
export type AutoRoutingScorerState = AutoRouter["status"]["scorer"];
export type AutoRouterCreate = archestraApiTypes.CreateAutoRouterData["body"];
export type AutoRouterUpdate = archestraApiTypes.UpdateAutoRouterData["body"];
export type AutoRoutingUsage =
  archestraApiTypes.GetAutoRoutingUsageResponses["200"];
export type AutoRoutingPlanDetail =
  archestraApiTypes.GetAutoRoutingPlanResponses["200"];
type AutoRoutingSimulateBody =
  archestraApiTypes.SimulateAutoRoutingData["body"];
export type AutoRoutingSimulation =
  archestraApiTypes.SimulateAutoRoutingResponses["200"];
export type AutoRoutingBackfillState =
  archestraApiTypes.GetAutoRoutingBackfillResponses["200"];
type AutoRoutingScoreBackfillBody =
  archestraApiTypes.ScoreAutoRoutingBackfillData["body"];

const autoRoutingKeys = {
  all: ["auto-routing"] as const,
  state: () => [...autoRoutingKeys.all, "state"] as const,
  routers: () => [...autoRoutingKeys.all, "routers"] as const,
  available: () => [...autoRoutingKeys.all, "available"] as const,
  router: (routerId: string | null) =>
    [...autoRoutingKeys.all, "router", routerId] as const,
  usage: (routerId: string | null) =>
    [...autoRoutingKeys.router(routerId), "usage"] as const,
  planDetails: (routerId: string | null) =>
    [...autoRoutingKeys.router(routerId), "plan"] as const,
  plan: (routerId: string | null, id: string | null) =>
    [...autoRoutingKeys.planDetails(routerId), id] as const,
  simulations: (routerId: string | null) =>
    [...autoRoutingKeys.router(routerId), "simulate"] as const,
  simulation: (routerId: string | null, body: AutoRoutingSimulateBody | null) =>
    [...autoRoutingKeys.simulations(routerId), body] as const,
  backfill: () => [...autoRoutingKeys.all, "backfill"] as const,
};

/**
 * The router the pages and dialogs under it read and change. Null where
 * there is none yet, as in the dialog that creates one.
 */
export const AutoRouterIdContext = createContext<string | null>(null);

export function useAutoRouterId(): string | null {
  return useContext(AutoRouterIdContext);
}

/** The organization switch, and what a router may be built from. */
export function useAutoRoutingState({
  enabled = true,
}: {
  enabled?: boolean;
} = {}) {
  return useQuery({
    enabled,
    queryKey: autoRoutingKeys.state(),
    queryFn: async () => {
      const { data, error } = await getAutoRoutingState();
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
    // Eligible keys and decision keys change on other pages.
    refetchOnMount: "always",
  });
}

export function useUpdateAutoRoutingState() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean) => {
      const { data, error } = await updateAutoRoutingState({
        body: { enabled },
      });
      throwOnApiError(error);
      return data;
    },
    onSuccess: async (data) => {
      if (!data) return;
      toast.success(
        data.enabled ? "Auto routing is on" : "Auto routing is off",
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: autoRoutingKeys.all }),
        queryClient.invalidateQueries({
          queryKey: organizationKeys.defaultModel(),
        }),
      ]);
    },
  });
}

export function useAutoRouters({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    enabled,
    queryKey: autoRoutingKeys.routers(),
    queryFn: async () => {
      const { data, error } = await getAutoRouters();
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
    // The scorer state follows Jev keys and their grants, which change on other pages.
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
  });
}

/** The routers' names and the virtual keys on each, for whoever grants them. */
export function useAvailableAutoRouters({
  enabled = true,
}: {
  enabled?: boolean;
} = {}) {
  return useQuery({
    enabled,
    queryKey: autoRoutingKeys.available(),
    queryFn: async () => {
      const { data, error } = await getAvailableAutoRouters();
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
  });
}

/** The router of `AutoRouterIdContext`; null data when it does not exist. */
export function useAutoRouter() {
  const routerId = useAutoRouterId();
  const query = useAutoRouters({ enabled: routerId !== null });
  return {
    ...query,
    data: query.data
      ? (query.data.find((router) => router.id === routerId) ?? null)
      : undefined,
  };
}

/** What the router routed over the last week: spend and sessions per tier, and the all-smart counterfactual. */
/** The usage windows the router page offers. */
export type AutoRoutingUsageDays = 7 | 14;

export function useAutoRoutingUsage(days: AutoRoutingUsageDays) {
  const routerId = useAutoRouterId();
  return useQuery({
    queryKey: [...autoRoutingKeys.usage(routerId), days],
    queryFn: async () => {
      if (!routerId) return null;
      const { data, error } = await getAutoRoutingUsage({
        path: { id: routerId },
        query: { days },
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
    enabled: routerId !== null,
  });
}

export function useAutoRoutingPlan(planId: string | null) {
  const routerId = useAutoRouterId();
  return useQuery({
    queryKey: autoRoutingKeys.plan(routerId, planId),
    queryFn: async () => {
      if (!routerId || !planId) return null;
      const { data, error } = await getAutoRoutingPlan({
        path: { id: routerId, planId },
      });
      throwOnApiError(error, { allowNotFound: true });
      return data ?? null;
    },
    enabled: !!routerId && !!planId,
  });
}

export function useCreateAutoRouter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: AutoRouterCreate) => {
      const { data, error } = await createAutoRouter({ body });
      throwOnApiError(error);
      return data;
    },
    onSuccess: (data) => applyFit(queryClient, data, "Auto router created"),
  });
}

export function useUpdateAutoRouter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      body,
    }: {
      id: string;
      body: AutoRouterUpdate;
    }) => {
      const { data, error } = await updateAutoRouter({ path: { id }, body });
      throwOnApiError(error);
      return data;
    },
    onSuccess: (data) => applyFit(queryClient, data, "Auto router saved"),
  });
}

export function useDeleteAutoRouter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await deleteAutoRouter({ path: { id } });
      throwOnApiError(error);
      return data;
    },
    onSuccess: async () => {
      toast.success("Auto router deleted");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: autoRoutingKeys.all }),
        queryClient.invalidateQueries({
          queryKey: organizationKeys.defaultModel(),
        }),
      ]);
    },
  });
}

/** The response already carries the fit's outcome; everything read from the router needs refetching. */
async function applyFit(
  queryClient: QueryClient,
  data: AutoRouterChange | undefined,
  saved: string,
) {
  if (!data) return;
  queryClient.setQueryData<AutoRouter[]>(
    autoRoutingKeys.routers(),
    (routers) =>
      routers?.some((router) => router.id === data.id)
        ? routers.map((router) => (router.id === data.id ? data : router))
        : routers && [...routers, data],
  );
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: autoRoutingKeys.available() }),
    queryClient.invalidateQueries({
      queryKey: autoRoutingKeys.router(data.id),
    }),
    queryClient.invalidateQueries({ queryKey: autoRoutingKeys.backfill() }),
    queryClient.invalidateQueries({
      queryKey: organizationKeys.defaultModel(),
    }),
  ]);
  switch (data.fit?.status) {
    case undefined:
      toast.success(saved);
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

/**
 * A fit at `body`'s budget and traffic that publishes nothing; idle while
 * `body` is null. The backend runs one simulation per router at a time,
 * so one refused while an abandoned earlier one finishes is retried.
 */
export function useSimulateAutoRouting(body: AutoRoutingSimulateBody | null) {
  const routerId = useAutoRouterId();
  return useQuery({
    queryKey: autoRoutingKeys.simulation(routerId, body),
    queryFn: async () => {
      if (!routerId || !body) return null;
      const { data, error } = await simulateAutoRouting({
        path: { id: routerId },
        body,
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
    enabled: routerId !== null && body !== null,
    retry: (failures, error) =>
      failures < SIMULATION_RETRIES &&
      getApiErrorType(error.cause) === "api_rate_limit_error",
    retryDelay: SIMULATION_RETRY_DELAY_MS,
  });
}

const SIMULATION_RETRIES = 10;
const SIMULATION_RETRY_DELAY_MS = 1000;

const BACKFILL_POLL_MS = 5000;

/**
 * The organization's latest historical backfill, polled while it runs and
 * then until the fit its completion requested has an outcome.
 */
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
      if (
        previous?.backfill &&
        (previous.backfill.status !== data?.backfill?.status ||
          previous.backfill.awaitingFit !== data?.backfill?.awaitingFit)
      ) {
        await queryClient.invalidateQueries({
          predicate: (query) =>
            query.queryKey[0] === autoRoutingKeys.all[0] &&
            query.queryKey[1] !== "backfill",
        });
      }
      return data ?? null;
    },
    refetchInterval: (query) => {
      const backfill = query.state.data?.backfill;
      return backfill?.status === "running" || backfill?.awaitingFit
        ? BACKFILL_POLL_MS
        : false;
    },
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
    // A refused offer is stale: show the current one.
    onError: () =>
      queryClient.invalidateQueries({ queryKey: autoRoutingKeys.backfill() }),
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
