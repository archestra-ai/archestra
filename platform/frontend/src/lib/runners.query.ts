import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { throwOnApiError } from "./utils";

const {
  getAllRunners,
  getRunner,
  getRunnerPreflight,
  getRunnerLabelKeys,
  getRunnerLabelValues,
  createRunner,
  updateRunner,
  deleteRunner,
  bulkDeleteRunners,
} = archestraApiSdk;

export type Runner =
  archestraApiTypes.GetAllRunnersResponses["200"]["runners"][number];

export type RunnerListFilters = {
  search?: string;
  environmentId?: string;
  /** Serialized as `key:a|b;key2:c` — the shape the list endpoint filters on. */
  labels?: string;
  limit?: number;
  offset?: number;
};

export const runnersKeys = {
  all: ["runners"] as const,
  list: (filters: RunnerListFilters) =>
    [...runnersKeys.all, "list", filters] as const,
  byId: (id: string) => [...runnersKeys.all, "byId", id] as const,
  preflight: (id: string) => [...runnersKeys.all, "preflight", id] as const,
  labelKeys: () => [...runnersKeys.all, "labelKeys"] as const,
  labelValues: (key: string | undefined) =>
    [...runnersKeys.all, "labelValues", key ?? null] as const,
};

export function useRunners(filters: RunnerListFilters = {}) {
  return useQuery({
    queryKey: runnersKeys.list(filters),
    queryFn: async () => {
      const { data, error } = await getAllRunners({ query: filters });
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
  });
}

export function useRunner(runnerId: string | null) {
  return useQuery({
    queryKey: runnersKeys.byId(runnerId ?? ""),
    enabled: Boolean(runnerId),
    queryFn: async () => {
      const { data, error } = await getRunner({
        path: { id: runnerId as string },
      });
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
  });
}

/**
 * Credentials the current user still has to supply before this runner can act
 * as them. Read before offering to run, so the UI can say what is missing
 * rather than failing on click.
 */
export function useRunnerPreflight(runnerId: string | null) {
  return useQuery({
    queryKey: runnersKeys.preflight(runnerId ?? ""),
    enabled: Boolean(runnerId),
    queryFn: async () => {
      const { data, error } = await getRunnerPreflight({
        path: { id: runnerId as string },
      });
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
  });
}

export function useRunnerLabelKeys() {
  return useQuery({
    queryKey: runnersKeys.labelKeys(),
    queryFn: async () => {
      const { data, error } = await getRunnerLabelKeys();
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
  });
}

export function useRunnerLabelValues({ key }: { key?: string }) {
  return useQuery({
    queryKey: runnersKeys.labelValues(key),
    enabled: Boolean(key),
    queryFn: async () => {
      const { data, error } = await getRunnerLabelValues({
        query: { key },
      });
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
  });
}

type CreateRunnerBody = Parameters<typeof createRunner>[0] extends {
  body?: infer B;
}
  ? NonNullable<B>
  : never;

export function useCreateRunner() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateRunnerBody) => {
      const { data, error } = await createRunner({ body });
      throwOnApiError(error);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: runnersKeys.all });
    },
  });
}

export function useUpdateRunner() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      body,
    }: {
      id: string;
      body: Parameters<typeof updateRunner>[0] extends { body?: infer B }
        ? NonNullable<B>
        : never;
    }) => {
      const { data, error } = await updateRunner({ path: { id }, body });
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

export function useBulkDeleteRunners() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      const { data, error } = await bulkDeleteRunners({ body: { ids } });
      throwOnApiError(error);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: runnersKeys.all });
    },
  });
}
