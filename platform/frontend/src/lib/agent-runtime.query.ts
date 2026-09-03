import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FileUIPart } from "ai";
import { toast } from "sonner";
import { reportApiError, throwOnApiError } from "@/lib/utils";

const {
  cancelAgentRun,
  deleteAgentRun,
  deleteAgentRuntimeCredential,
  getAgentRuntimePreflight,
  getAgentRunShare,
  getAgentRuns,
  getMyAgentRun,
  getMyAgentRuns,
  setAgentRuntimeCredential,
  shareAgentRun,
  startAgentRun,
  unshareAgentRun,
  updateAgentRun,
} = archestraApiSdk;

export type AgentRun = archestraApiTypes.GetAgentRunsResponses["200"][number];
export type AgentRunSession =
  archestraApiTypes.GetMyAgentRunsResponses["200"]["data"][number];

export function useAgentRuntimePreflight(agentId: string, enabled = true) {
  return useQuery({
    queryKey: ["agents", agentId, "runtime", "preflight"],
    queryFn: async () => {
      const { data, error } = await getAgentRuntimePreflight({
        path: { id: agentId },
      });
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
    enabled,
  });
}

export function useAgentRuns(agentId: string, enabled = true) {
  return useQuery({
    queryKey: ["agents", agentId, "runs"],
    queryFn: async () => {
      const { data, error } = await getAgentRuns({
        path: { id: agentId },
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
    enabled,
    refetchInterval: enabled ? 5_000 : false,
  });
}

export function useMyAgentRuns(enabled = true) {
  return useQuery({
    queryKey: ["agent-runs", "mine"],
    queryFn: loadMyAgentRuns,
    enabled,
    refetchInterval: (query) =>
      enabled && query.state.data?.some((run) => !run.endedAt) ? 3_000 : false,
  });
}

export function useMyAgentRun(taskId: string, enabled = true) {
  return useQuery({
    queryKey: ["agent-runs", taskId],
    queryFn: async () => {
      const { data, error } = await getMyAgentRun({ path: { taskId } });
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
    enabled: enabled && !!taskId,
    refetchInterval: (query) =>
      query.state.status === "error" || query.state.data?.endedAt
        ? false
        : 2_000,
    retry: (failureCount) => failureCount < 8,
    retryDelay: 500,
  });
}

export function useStartAgentRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      agentId,
      message,
      files,
      projectId,
    }: {
      agentId: string;
      message: string;
      files?: FileUIPart[];
      projectId?: string;
    }) => {
      const attachments = files?.map(runAttachmentFromFile);
      const { data, error } = await startAgentRun({
        path: { id: agentId },
        body: { message, attachments, projectId },
      });
      if (error) throw reportApiError(error);
      return data;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agent-runs"] }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
      ]);
    },
  });
}

export function useCancelAgentRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (taskId: string) => {
      const { data, error } = await cancelAgentRun({ path: { taskId } });
      if (error) throw reportApiError(error);
      return { data, taskId };
    },
    onSuccess: async ({ taskId }) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["agent-runs", taskId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["agent-runs", "mine"],
        }),
      ]);
    },
  });
}

export function useUpdateAgentRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      taskId,
      ...body
    }: {
      taskId: string;
      title?: string;
      pinnedAt?: string | null;
      projectId?: string | null;
    }) => {
      const { data, error } = await updateAgentRun({
        path: { taskId },
        body,
      });
      if (error) throw reportApiError(error);
      return data;
    },
    onSuccess: async (run) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["agent-runs", run?.taskId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["agent-runs", "mine"],
        }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
      ]);
    },
  });
}

export function useDeleteAgentRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (taskId: string) => {
      const { data, error } = await deleteAgentRun({ path: { taskId } });
      if (error) throw reportApiError(error);
      return data;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agent-runs"] }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
      ]);
    },
  });
}

export type AgentRunShare = NonNullable<
  archestraApiTypes.GetAgentRunShareResponses["200"]
>;

/**
 * Owner-only: reads the current share for a run. The route 404s for
 * anyone but the owner, so this is only queried behind the owner's share
 * dialog. A `null` result means the run is private (not shared).
 */
export function useAgentRunShare(taskId: string | undefined) {
  return useQuery({
    queryKey: ["agent-runs", taskId, "share"],
    queryFn: async () => {
      if (!taskId) return null;
      const { data, error } = await getAgentRunShare({
        path: { taskId },
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
    enabled: !!taskId,
    staleTime: 30 * 1000,
    gcTime: 5 * 60 * 1000,
  });
}

type ShareAgentRunInput = {
  taskId: string;
  suppressSuccessToast?: boolean;
} & archestraApiTypes.ShareAgentRunData["body"];

export function useShareAgentRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      taskId,
      visibility,
      teamIds,
      userIds,
      suppressSuccessToast: _suppressSuccessToast,
    }: ShareAgentRunInput) => {
      const { data, error } = await shareAgentRun({
        path: { taskId },
        body: { visibility, teamIds, userIds },
      });
      if (error) throw reportApiError(error);
      return data;
    },
    onSuccess: (data, { taskId, suppressSuccessToast }) => {
      if (!data) return;
      queryClient.setQueryData(["agent-runs", taskId, "share"], data);
      if (!suppressSuccessToast) {
        toast.success("Run visibility updated");
      }
    },
  });
}

export function useUnshareAgentRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (taskId: string) => {
      const { data, error } = await unshareAgentRun({ path: { taskId } });
      if (error) throw reportApiError(error);
      return data;
    },
    onSuccess: (_data, taskId) => {
      queryClient.setQueryData(["agent-runs", taskId, "share"], null);
      toast.success("Run sharing removed");
    },
  });
}

function runAttachmentFromFile(file: FileUIPart): {
  name: string;
  contentType: string;
  contentBase64: string;
} {
  const match = /^data:([^;,]+)?;base64,([\s\S]+)$/.exec(file.url);
  if (!match) {
    throw new Error(`Could not prepare "${file.filename}" for upload`);
  }
  return {
    name: file.filename ?? "attachment",
    contentType: file.mediaType ?? match[1] ?? "application/octet-stream",
    contentBase64: match[2],
  };
}

export function useSetAgentRuntimeCredential(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string }) => {
      const { data, error } = await setAgentRuntimeCredential({
        path: { id: agentId, key },
        body: { value },
      });
      if (error) throw reportApiError(error);
      return data;
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["agents", agentId, "runtime", "preflight"],
      }),
  });
}

export function useDeleteAgentRuntimeCredential(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (key: string) => {
      const { data, error } = await deleteAgentRuntimeCredential({
        path: { id: agentId, key },
      });
      if (error) throw reportApiError(error);
      return data;
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["agents", agentId, "runtime", "preflight"],
      }),
  });
}

async function loadMyAgentRuns(): Promise<AgentRunSession[]> {
  const runs: AgentRunSession[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await getMyAgentRuns({
      query: { limit: MY_RUNS_PAGE_SIZE, offset },
    });
    throwOnApiError(error, { toastOnError: false });
    runs.push(...(data?.data ?? []));

    if (!data?.pagination.hasNext) {
      return runs;
    }
    offset += MY_RUNS_PAGE_SIZE;
  }
}

const MY_RUNS_PAGE_SIZE = 100;
