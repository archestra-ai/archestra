import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FileUIPart } from "ai";
import { toast } from "sonner";
import {
  hasRecentlyEnded,
  hasRetainedSessionActivity,
} from "@/lib/agent-run-activity";
import { reportApiError, throwOnApiError } from "@/lib/utils";

const {
  cancelAgentRun,
  continueAgentRun,
  deleteAgentRun,
  deleteAgentWorkspace,
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

export type AgentRunListItem =
  archestraApiTypes.GetAgentRunsResponses["200"][number];
export type AgentRun = Omit<
  AgentRunListItem,
  "initiatorName" | "shareVisibility" | "shareTeamNames" | "shareUserNames"
>;
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
    refetchInterval: (query) => {
      if (!enabled) return false;
      const runs = query.state.data ?? [];
      const now = Date.now();
      if (
        runs.some((run) => !run.endedAt || hasRetainedSessionActivity(run, now))
      ) {
        return 3_000;
      }
      // Keep a slow watch on turns that just ended: the list would otherwise
      // never notice a retained session working again or a continuation.
      return runs.some((run) => hasRecentlyEnded(run, now)) ? 10_000 : false;
    },
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
    refetchInterval: (query) => {
      const run = query.state.data;
      if (query.state.status === "error") return false;
      if (!run?.endedAt || hasRetainedSessionActivity(run)) return 2_000;
      if (!run.workspace || run.workspace.state === "deleted") return false;
      if (["idle", "suspended"].includes(run.workspace.state)) {
        return hasRecentlyEnded(run) ? 10_000 : 30_000;
      }
      return 2_000;
    },
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

export function useContinueAgentRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      taskId,
      message,
    }: {
      taskId: string;
      message: string;
    }) => {
      const { data, error } = await continueAgentRun({
        path: { taskId },
        body: { message },
      });
      if (error) throw reportApiError(error);
      return data;
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["agent-runs"] }),
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

export function useDeleteAgentWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (taskId: string) => {
      const { data, error } = await deleteAgentWorkspace({ path: { taskId } });
      if (error) throw reportApiError(error);
      return data;
    },
    onSuccess: async () => {
      toast.success("Workspace deleted. Run history is still available.");
      await queryClient.invalidateQueries({ queryKey: ["agent-runs"] });
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
    onSuccess: async (data, { taskId, suppressSuccessToast }) => {
      if (!data) return;
      queryClient.setQueryData(["agent-runs", taskId, "share"], data);
      await queryClient.invalidateQueries({
        predicate: ({ queryKey }) =>
          queryKey[0] === "agents" && queryKey[2] === "runs",
      });
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
    onSuccess: async (_data, taskId) => {
      queryClient.setQueryData(["agent-runs", taskId, "share"], null);
      await queryClient.invalidateQueries({
        predicate: ({ queryKey }) =>
          queryKey[0] === "agents" && queryKey[2] === "runs",
      });
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

/** Save independently so a failed connection does not discard successful ones. */
export function useSetMissingAgentRuntimeCredentials(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (credentials: Array<{ key: string; value: string }>) => {
      const saved: string[] = [];
      const failed: string[] = [];
      // Agent-specific shared secrets update one bag. Concurrent writes could
      // each read the old bag and overwrite another credential's value.
      for (const { key, value } of credentials) {
        try {
          const { error } = await setAgentRuntimeCredential({
            path: { id: agentId, key },
            body: { value },
          });
          if (error) throw reportApiError(error);
          saved.push(key);
        } catch {
          failed.push(key);
        }
      }
      return { saved, failed };
    },
    onSuccess: async ({ saved, failed }) => {
      if (failed.length > 0) {
        toast.error(
          "Some credentials could not be saved. Retry the remaining fields.",
        );
      } else if (saved.length > 0) {
        toast.success("Credentials saved");
      }
      // Reusable connections may also satisfy other Agents' preflights.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["runtime-credentials"] }),
        queryClient.invalidateQueries({
          predicate: (query) =>
            query.queryKey[0] === "agents" &&
            query.queryKey[2] === "runtime" &&
            query.queryKey[3] === "preflight",
        }),
      ]);
    },
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
