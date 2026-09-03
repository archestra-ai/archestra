import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FileUIPart } from "ai";
import { toast } from "sonner";
import { reportApiError, throwOnApiError } from "@/lib/utils";

const {
  cancelAgentExecution,
  deleteAgentExecution,
  deleteAgentBackgroundExecutionCredential,
  getAgentBackgroundExecutionPreflight,
  getAgentExecutionShare,
  getAgentExecutions,
  getMyAgentExecution,
  getMyAgentExecutions,
  setAgentBackgroundExecutionCredential,
  shareAgentExecution,
  startAgentExecution,
  unshareAgentExecution,
  updateAgentExecution,
} = archestraApiSdk;

export type AgentExecution =
  archestraApiTypes.GetAgentExecutionsResponses["200"][number];
export type AgentExecutionSession =
  archestraApiTypes.GetMyAgentExecutionsResponses["200"][number];

export function useAgentBackgroundExecutionPreflight(
  agentId: string,
  enabled = true,
) {
  return useQuery({
    queryKey: ["agents", agentId, "background-execution", "preflight"],
    queryFn: async () => {
      const { data, error } = await getAgentBackgroundExecutionPreflight({
        path: { id: agentId },
      });
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
    enabled,
  });
}

export function useAgentExecutions(agentId: string, enabled = true) {
  return useQuery({
    queryKey: ["agents", agentId, "executions"],
    queryFn: async () => {
      const { data, error } = await getAgentExecutions({
        path: { id: agentId },
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
    enabled,
    refetchInterval: enabled ? 5_000 : false,
  });
}

export function useMyAgentExecutions(enabled = true) {
  return useQuery({
    queryKey: ["agent-executions", "mine"],
    queryFn: async () => {
      const { data, error } = await getMyAgentExecutions();
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
    enabled,
    refetchInterval: enabled ? 3_000 : false,
  });
}

export function useMyAgentExecution(taskId: string, enabled = true) {
  return useQuery({
    queryKey: ["agent-executions", taskId],
    queryFn: async () => {
      const { data, error } = await getMyAgentExecution({ path: { taskId } });
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

export function useStartAgentExecution() {
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
      const attachments = files?.map(executionAttachmentFromFile);
      const { data, error } = await startAgentExecution({
        path: { id: agentId },
        body: { message, attachments, projectId },
      });
      if (error) throw reportApiError(error);
      return data;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agent-executions"] }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
      ]);
    },
  });
}

export function useCancelAgentExecution() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (taskId: string) => {
      const { data, error } = await cancelAgentExecution({ path: { taskId } });
      if (error) throw reportApiError(error);
      return { data, taskId };
    },
    onSuccess: async ({ taskId }) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["agent-executions", taskId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["agent-executions", "mine"],
        }),
      ]);
    },
  });
}

export function useUpdateAgentExecution() {
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
      const { data, error } = await updateAgentExecution({
        path: { taskId },
        body,
      });
      if (error) throw reportApiError(error);
      return data;
    },
    onSuccess: async (execution) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["agent-executions", execution?.taskId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["agent-executions", "mine"],
        }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
      ]);
    },
  });
}

export function useDeleteAgentExecution() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (taskId: string) => {
      const { data, error } = await deleteAgentExecution({ path: { taskId } });
      if (error) throw reportApiError(error);
      return data;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agent-executions"] }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
      ]);
    },
  });
}

export type AgentExecutionShare = NonNullable<
  archestraApiTypes.GetAgentExecutionShareResponses["200"]
>;

/**
 * Owner-only: reads the current share for an execution. The route 404s for
 * anyone but the owner, so this is only queried behind the owner's share
 * dialog. A `null` result means the execution is private (not shared).
 */
export function useAgentExecutionShare(taskId: string | undefined) {
  return useQuery({
    queryKey: ["agent-executions", taskId, "share"],
    queryFn: async () => {
      if (!taskId) return null;
      const { data, error } = await getAgentExecutionShare({
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

type ShareAgentExecutionInput = {
  taskId: string;
  suppressSuccessToast?: boolean;
} & archestraApiTypes.ShareAgentExecutionData["body"];

export function useShareAgentExecution() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      taskId,
      visibility,
      teamIds,
      userIds,
      suppressSuccessToast: _suppressSuccessToast,
    }: ShareAgentExecutionInput) => {
      const { data, error } = await shareAgentExecution({
        path: { taskId },
        body: { visibility, teamIds, userIds },
      });
      if (error) throw reportApiError(error);
      return data;
    },
    onSuccess: (data, { taskId, suppressSuccessToast }) => {
      if (!data) return;
      queryClient.setQueryData(["agent-executions", taskId, "share"], data);
      if (!suppressSuccessToast) {
        toast.success("Execution visibility updated");
      }
    },
  });
}

export function useUnshareAgentExecution() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (taskId: string) => {
      const { data, error } = await unshareAgentExecution({ path: { taskId } });
      if (error) throw reportApiError(error);
      return data;
    },
    onSuccess: (_data, taskId) => {
      queryClient.setQueryData(["agent-executions", taskId, "share"], null);
      toast.success("Execution sharing removed");
    },
  });
}

function executionAttachmentFromFile(file: FileUIPart): {
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

export function useSetAgentBackgroundExecutionCredential(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string }) => {
      const { data, error } = await setAgentBackgroundExecutionCredential({
        path: { id: agentId, key },
        body: { value },
      });
      if (error) throw reportApiError(error);
      return data;
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["agents", agentId, "background-execution", "preflight"],
      }),
  });
}

export function useDeleteAgentBackgroundExecutionCredential(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (key: string) => {
      const { data, error } = await deleteAgentBackgroundExecutionCredential({
        path: { id: agentId, key },
      });
      if (error) throw reportApiError(error);
      return data;
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["agents", agentId, "background-execution", "preflight"],
      }),
  });
}
