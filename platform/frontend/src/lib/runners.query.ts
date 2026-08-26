import { archestraApiSdk } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { throwOnApiError } from "./utils";

const {
  getAllRunners,
  getRunner,
  getRunnerEvents,
  getRunnerPreflight,
  createRunner,
  steerRunner,
  stopRunner,
  deleteRunner,
} = archestraApiSdk;

export const runnersKeys = {
  all: ["runners"] as const,
  list: () => [...runnersKeys.all, "list"] as const,
  byId: (id: string) => [...runnersKeys.all, "byId", id] as const,
  events: (id: string) => [...runnersKeys.all, "events", id] as const,
  preflight: (agentId: string) =>
    [...runnersKeys.all, "preflight", agentId] as const,
};

export function useRunners() {
  return useQuery({
    queryKey: runnersKeys.list(),
    queryFn: async () => {
      const { data, error } = await getAllRunners();
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
    // A provisioning session changes state without anyone acting, so the list
    // refreshes on its own rather than looking stuck until a manual reload.
    refetchInterval: 5000,
  });
}

export function useRunner(runnerId: string) {
  return useQuery({
    queryKey: runnersKeys.byId(runnerId),
    queryFn: async () => {
      const { data, error } = await getRunner({ path: { id: runnerId } });
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
    refetchInterval: 5000,
  });
}

export function useRunnerEvents(runnerId: string) {
  return useQuery({
    queryKey: runnersKeys.events(runnerId),
    queryFn: async () => {
      const { data, error } = await getRunnerEvents({ path: { id: runnerId } });
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
    refetchInterval: 5000,
  });
}

/**
 * What the current user still has to supply before this agent can be run.
 * Read before offering to start one, so the button can say what is missing
 * instead of failing on click.
 */
export function useRunnerPreflight(agentId: string | null) {
  return useQuery({
    queryKey: runnersKeys.preflight(agentId ?? ""),
    enabled: Boolean(agentId),
    queryFn: async () => {
      const { data, error } = await getRunnerPreflight({
        query: { agentId: agentId as string },
      });
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
  });
}

export function useCreateRunner() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      agentId: string;
      name: string;
      task?: string;
    }) => {
      const { data, error } = await createRunner({ body });
      throwOnApiError(error);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: runnersKeys.all });
    },
  });
}

export function useSteerRunner(runnerId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (message: string) => {
      const { data, error } = await steerRunner({
        path: { id: runnerId },
        body: { message },
      });
      throwOnApiError(error);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: runnersKeys.events(runnerId) });
    },
  });
}

export function useStopRunner() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (runnerId: string) => {
      const { data, error } = await stopRunner({ path: { id: runnerId } });
      throwOnApiError(error);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: runnersKeys.all });
    },
  });
}

export function useDeleteRunner() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (runnerId: string) => {
      const { data, error } = await deleteRunner({ path: { id: runnerId } });
      throwOnApiError(error);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: runnersKeys.all });
    },
  });
}
