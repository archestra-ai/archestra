import { archestraApiSdk, type PaginationMeta } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "./utils";

const {
  getScheduleTriggers,
  getScheduleTrigger,
  createScheduleTrigger,
  updateScheduleTrigger,
  deleteScheduleTrigger,
  enableScheduleTrigger,
  disableScheduleTrigger,
  runScheduleTriggerNow,
  getScheduleTriggerRuns,
  getScheduleTriggerRun,
  createScheduleTriggerRunConversation,
} = archestraApiSdk;

export type ScheduleTriggerRunStatus = "running" | "success" | "failed";

export type ScheduleTriggerRunKind = "due" | "manual";

export type ScheduleTrigger = {
  id: string;
  organizationId: string;
  name: string;
  agentId: string;
  messageTemplate: string;
  cronExpression: string;
  timezone: string;
  enabled: boolean;
  actorUserId: string;
  lastExecutedAt: string | null;
  createdAt: string;
  actor?: {
    id: string;
    name: string | null;
    email: string | null;
  } | null;
  agent?: {
    id: string;
    name: string | null;
    agentType: string | null;
  } | null;
};

export type ScheduleTriggerRun = {
  id: string;
  organizationId: string;
  triggerId: string;
  runKind: ScheduleTriggerRunKind;
  status: ScheduleTriggerRunStatus;
  initiatedByUserId: string | null;
  chatConversationId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  createdAt: string;
};

type PaginatedResponse<T> = {
  data: T[];
  pagination: PaginationMeta;
};

type ScheduleTriggerRequestBody = {
  name: string;
  agentId: string;
  cronExpression: string;
  timezone: string;
  messageTemplate: string;
  enabled?: boolean;
};

export const scheduleTriggerKeys = {
  all: ["schedule-triggers"] as const,
  detail: (triggerId: string) =>
    [...scheduleTriggerKeys.all, "detail", triggerId] as const,
  list: (params: {
    enabled?: boolean;
    limit?: number;
    offset?: number;
    agentIds?: string[];
  }) => [...scheduleTriggerKeys.all, "list", params] as const,
  runsPrefix: (triggerId: string) =>
    [...scheduleTriggerKeys.all, triggerId, "runs"] as const,
  runs: (
    triggerId: string,
    params: {
      limit?: number;
      offset?: number;
      status?: ScheduleTriggerRunStatus;
    },
  ) => [...scheduleTriggerKeys.runsPrefix(triggerId), params] as const,
  run: (triggerId: string, runId: string) =>
    [...scheduleTriggerKeys.runsPrefix(triggerId), "detail", runId] as const,
  status: () => [...scheduleTriggerKeys.all, "status"] as const,
};

export function getScheduleTriggerListQueryParams(params?: {
  enabled?: boolean;
  limit?: number;
  offset?: number;
  name?: string;
  actorUserIds?: string[];
  agentIds?: string[];
  showAll?: boolean;
  refetchInterval?: number | false;
}) {
  return {
    enabled: params?.enabled,
    limit: params?.limit,
    offset: params?.offset,
    name: params?.name,
    actorUserIds: params?.actorUserIds,
    agentIds: params?.agentIds,
    showAll: params?.showAll,
  };
}

export function getScheduleTriggerRunsQueryParams(params?: {
  limit?: number;
  offset?: number;
  status?: ScheduleTriggerRunStatus;
  enabled?: boolean;
  refetchInterval?: number | false;
}) {
  return {
    limit: params?.limit,
    offset: params?.offset,
    status: params?.status,
  };
}

export function useScheduleTriggers(params?: {
  enabled?: boolean;
  limit?: number;
  offset?: number;
  name?: string;
  actorUserIds?: string[];
  agentIds?: string[];
  showAll?: boolean;
  refetchInterval?: number | false;
}) {
  const queryParams = getScheduleTriggerListQueryParams(params);
  const emptyResponse: PaginatedResponse<ScheduleTrigger> = {
    data: [],
    pagination: EMPTY_PAGINATION,
  };

  return useQuery({
    queryKey: scheduleTriggerKeys.list(queryParams),
    queryFn: async () => {
      const response = await getScheduleTriggers({
        query: {
          limit: queryParams.limit ?? 50,
          offset: queryParams.offset ?? 0,
          ...(queryParams.enabled !== undefined
            ? { enabled: queryParams.enabled }
            : {}),
          ...(queryParams.name ? { name: queryParams.name } : {}),
          ...(queryParams.actorUserIds?.length
            ? { actorUserIds: queryParams.actorUserIds.join(",") }
            : {}),
          ...(queryParams.agentIds?.length
            ? { agentIds: queryParams.agentIds.join(",") }
            : {}),
          ...(queryParams.showAll ? { showAll: queryParams.showAll } : {}),
        },
      });
      if (response.error) {
        handleApiError(response.error);
        return emptyResponse;
      }
      return (
        (response.data as PaginatedResponse<ScheduleTrigger>) ?? emptyResponse
      );
    },
    ...(params?.refetchInterval
      ? { refetchInterval: params.refetchInterval }
      : {}),
  });
}

export function useScheduleTrigger(
  triggerId: string | null,
  params?: {
    enabled?: boolean;
    refetchInterval?: number | false;
  },
) {
  return useQuery({
    queryKey: scheduleTriggerKeys.detail(triggerId ?? ""),
    queryFn: async () => {
      const response = await getScheduleTrigger({
        path: { id: triggerId as string },
      });
      if (response.error) {
        handleApiError(response.error);
        return null;
      }
      return (response.data as ScheduleTrigger) ?? null;
    },
    enabled: !!triggerId && (params?.enabled ?? true),
    ...(params?.refetchInterval
      ? { refetchInterval: params.refetchInterval }
      : {}),
  });
}

export function useScheduleTriggerRuns(
  triggerId: string | null,
  params?: {
    limit?: number;
    offset?: number;
    status?: ScheduleTriggerRunStatus;
    enabled?: boolean;
    refetchInterval?: number | false;
  },
) {
  const queryParams = getScheduleTriggerRunsQueryParams(params);
  const emptyResponse: PaginatedResponse<ScheduleTriggerRun> = {
    data: [],
    pagination: EMPTY_PAGINATION,
  };

  return useQuery({
    queryKey: scheduleTriggerKeys.runs(triggerId ?? "", queryParams),
    queryFn: async () => {
      const response = await getScheduleTriggerRuns({
        path: { id: triggerId as string },
        query: {
          limit: queryParams.limit ?? 10,
          offset: queryParams.offset ?? 0,
          ...(queryParams.status ? { status: queryParams.status } : {}),
        },
      });
      if (response.error) {
        handleApiError(response.error);
        return emptyResponse;
      }
      return (
        (response.data as PaginatedResponse<ScheduleTriggerRun>) ??
        emptyResponse
      );
    },
    enabled: !!triggerId && (params?.enabled ?? true),
    ...(params?.refetchInterval
      ? { refetchInterval: params.refetchInterval }
      : {}),
  });
}

export function useHasActiveScheduleTriggers() {
  return useQuery({
    queryKey: scheduleTriggerKeys.status(),
    queryFn: async () => {
      const response = await getScheduleTriggers({
        query: { enabled: true, limit: 1, offset: 0 },
      });
      if (response.error) {
        handleApiError(response.error);
        return false;
      }
      const data = response.data as
        | PaginatedResponse<ScheduleTrigger>
        | undefined;
      return (data?.data.length ?? 0) > 0;
    },
  });
}

export function useScheduleTriggerRun(
  triggerId: string | null,
  runId: string | null,
  params?: {
    enabled?: boolean;
    refetchInterval?: number | false;
  },
) {
  return useQuery({
    queryKey: scheduleTriggerKeys.run(triggerId ?? "", runId ?? ""),
    queryFn: async () => {
      const response = await getScheduleTriggerRun({
        path: { id: triggerId as string, runId: runId as string },
      });
      if (response.error) {
        handleApiError(response.error);
        return null;
      }
      return (response.data as ScheduleTriggerRun) ?? null;
    },
    enabled: !!triggerId && !!runId && (params?.enabled ?? true),
    ...(params?.refetchInterval
      ? { refetchInterval: params.refetchInterval }
      : {}),
  });
}

export function useCreateScheduleTriggerRunConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      triggerId,
      runId,
    }: {
      triggerId: string;
      runId: string;
    }) => {
      const response = await createScheduleTriggerRunConversation({
        path: { id: triggerId, runId },
      });
      if (response.error) {
        handleApiError(response.error);
        throw new Error("Failed to create a conversation for this run");
      }
      return response.data as { id: string };
    },
    onSuccess: (conversation, variables) => {
      queryClient.invalidateQueries({
        queryKey: scheduleTriggerKeys.run(variables.triggerId, variables.runId),
      });
      queryClient.invalidateQueries({
        queryKey: scheduleTriggerKeys.runsPrefix(variables.triggerId),
      });
      queryClient.invalidateQueries({
        queryKey: ["conversations"],
      });
      queryClient.invalidateQueries({
        queryKey: ["conversation", conversation.id],
      });
    },
  });
}

export function useCreateScheduleTrigger() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (body: ScheduleTriggerRequestBody) => {
      const response = await createScheduleTrigger({ body });
      if (response.error) {
        handleApiError(response.error);
        return null;
      }
      return (response.data as ScheduleTrigger) ?? null;
    },
    onSuccess: (data) => {
      if (!data) return;
      toast.success("Schedule trigger created");
      queryClient.invalidateQueries({ queryKey: scheduleTriggerKeys.all });
    },
  });
}

export function useUpdateScheduleTrigger() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      body,
    }: {
      id: string;
      body: Partial<ScheduleTriggerRequestBody>;
    }) => {
      const response = await updateScheduleTrigger({
        path: { id },
        body,
      });
      if (response.error) {
        handleApiError(response.error);
        return null;
      }
      return (response.data as ScheduleTrigger) ?? null;
    },
    onSuccess: (data) => {
      if (!data) return;
      toast.success("Schedule trigger updated");
      queryClient.invalidateQueries({ queryKey: scheduleTriggerKeys.all });
    },
  });
}

export function useDeleteScheduleTrigger() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const response = await deleteScheduleTrigger({ path: { id } });
      if (response.error) {
        handleApiError(response.error);
        return null;
      }
      return response.data as { success: boolean } | null;
    },
    onSuccess: (data) => {
      if (!data?.success) return;
      toast.success("Schedule trigger deleted");
      queryClient.invalidateQueries({ queryKey: scheduleTriggerKeys.all });
    },
  });
}

export function useEnableScheduleTrigger() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const response = await enableScheduleTrigger({ path: { id } });
      if (response.error) {
        handleApiError(response.error);
        return null;
      }
      return (response.data as ScheduleTrigger) ?? null;
    },
    onSuccess: (data) => {
      if (!data) return;
      toast.success("Schedule trigger enabled");
      queryClient.invalidateQueries({ queryKey: scheduleTriggerKeys.all });
    },
  });
}

export function useDisableScheduleTrigger() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const response = await disableScheduleTrigger({ path: { id } });
      if (response.error) {
        handleApiError(response.error);
        return null;
      }
      return (response.data as ScheduleTrigger) ?? null;
    },
    onSuccess: (data) => {
      if (!data) return;
      toast.success("Schedule trigger disabled");
      queryClient.invalidateQueries({ queryKey: scheduleTriggerKeys.all });
    },
  });
}

export function useRunScheduleTriggerNow() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const response = await runScheduleTriggerNow({ path: { id } });
      if (response.error) {
        handleApiError(response.error);
        return null;
      }
      return (response.data as ScheduleTriggerRun) ?? null;
    },
    onSuccess: (data) => {
      if (!data) return;
      toast.success("Run queued");
      queryClient.invalidateQueries({ queryKey: scheduleTriggerKeys.all });
      queryClient.invalidateQueries({
        queryKey: scheduleTriggerKeys.runsPrefix(data.triggerId),
      });
    },
  });
}

// --- Internal constants ---

const EMPTY_PAGINATION: PaginationMeta = {
  currentPage: 1,
  limit: 50,
  total: 0,
  totalPages: 0,
  hasNext: false,
  hasPrev: false,
};
