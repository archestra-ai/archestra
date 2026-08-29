import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FileUIPart } from "ai";
import { reportApiError, throwOnApiError } from "@/lib/utils";

const {
  cancelAgentExecution,
  deleteAgentExecution,
  deleteAgentBackgroundExecutionCredential,
  getAgentBackgroundExecutionPreflight,
  getAgentExecutions,
  getMyAgentExecution,
  getMyAgentExecutions,
  setAgentBackgroundExecutionCredential,
  startAgentExecution,
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
    }: {
      agentId: string;
      message: string;
      files?: FileUIPart[];
    }) => {
      const attachments = files?.map(executionAttachmentFromFile);
      const { data, error } = await startAgentExecution({
        path: { id: agentId },
        body: { message, attachments },
      });
      if (error) throw reportApiError(error);
      return data;
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["agent-executions"] }),
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
      title,
    }: {
      taskId: string;
      title: string;
    }) => {
      const { data, error } = await updateAgentExecution({
        path: { taskId },
        body: { title },
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
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["agent-executions"] }),
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
