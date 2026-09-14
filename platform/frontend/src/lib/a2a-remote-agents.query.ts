import {
  archestraApiSdk,
  type archestraApiTypes,
  type ResourceVisibilityScope,
} from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { runBulkAction } from "@/lib/bulk-action";
import { handleApiError, throwOnApiError } from "./utils";

const {
  createA2aRemoteAgent,
  deleteA2aRemoteAgent,
  getAgentA2aDelegations,
  getA2aRemoteAgent,
  inspectA2aRemoteAgent,
  listA2aRemoteAgentRuns,
  listA2aRemoteAgents,
  syncAgentA2aDelegations,
  updateA2aRemoteAgent,
} = archestraApiSdk;

export type A2aRemoteAgent =
  archestraApiTypes.ListA2aRemoteAgentsResponses["200"][number];
export type CreateA2aRemoteAgentBody =
  archestraApiTypes.CreateA2aRemoteAgentData["body"];
export type UpdateA2aRemoteAgentBody =
  archestraApiTypes.UpdateA2aRemoteAgentData["body"];

export const a2aRemoteAgentQueryKeys = {
  all: ["a2a-remote-agents"] as const,
  list: (accessibleOnly: boolean) =>
    ["a2a-remote-agents", "list", { accessibleOnly }] as const,
  assignments: (agentId: string) =>
    ["a2a-remote-agents", "assignments", agentId] as const,
  runs: (remoteAgentId: string) =>
    ["a2a-remote-agents", "runs", remoteAgentId] as const,
};

export function useA2aRemoteAgents(options?: {
  enabled?: boolean;
  accessibleOnly?: boolean;
}) {
  const accessibleOnly = options?.accessibleOnly === true;
  return useQuery({
    queryKey: a2aRemoteAgentQueryKeys.list(accessibleOnly),
    queryFn: async () => {
      const response = await listA2aRemoteAgents(
        accessibleOnly ? { query: { accessibleOnly: true } } : undefined,
      );
      throwOnApiError(response.error);
      return response.data ?? [];
    },
    enabled: options?.enabled,
  });
}

export function useA2aRemoteAgent(id: string) {
  return useQuery({
    queryKey: [...a2aRemoteAgentQueryKeys.all, id],
    queryFn: async () => {
      const response = await getA2aRemoteAgent({ path: { id } });
      throwOnApiError(response.error, {
        allowNotFound: true,
        toastOnError: false,
      });
      return response.data ?? null;
    },
    enabled: !!id,
  });
}

export function useA2aRemoteAgentRuns(
  remoteAgentId: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: a2aRemoteAgentQueryKeys.runs(remoteAgentId),
    queryFn: async () => {
      const response = await listA2aRemoteAgentRuns({
        path: { id: remoteAgentId },
        query: { limit: 10 },
      });
      throwOnApiError(response.error);
      return response.data ?? [];
    },
    enabled: options?.enabled,
  });
}

export function useInspectA2aRemoteAgent() {
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.InspectA2aRemoteAgentData["body"],
    ) => {
      const response = await inspectA2aRemoteAgent({ body });
      throwOnApiError(response.error);
      return response.data;
    },
  });
}

export function useCreateA2aRemoteAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateA2aRemoteAgentBody) => {
      const response = await createA2aRemoteAgent({ body });
      if (response.error) {
        handleApiError(response.error);
        throw new Error("Failed to create outbound A2A agent");
      }
      return response.data;
    },
    onSuccess: () => {
      toast.success("External A2A agent connected");
      queryClient.invalidateQueries({ queryKey: a2aRemoteAgentQueryKeys.all });
    },
  });
}

export function useUpdateA2aRemoteAgent(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: UpdateA2aRemoteAgentBody) => {
      const response = await updateA2aRemoteAgent({ path: { id }, body });
      if (response.error) {
        handleApiError(response.error);
        throw new Error("Failed to update outbound A2A agent");
      }
      return response.data;
    },
    onSuccess: (agent) => {
      toast.success("External A2A agent updated");
      if (agent) {
        queryClient.setQueryData([...a2aRemoteAgentQueryKeys.all, id], agent);
      }
      queryClient.invalidateQueries({ queryKey: a2aRemoteAgentQueryKeys.all });
    },
  });
}

export function useBulkUpdateA2aRemoteAgentVisibility() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      agents,
      scope,
      teamIds,
      userIds,
    }: {
      agents: A2aRemoteAgent[];
      scope: ResourceVisibilityScope;
      teamIds: string[];
      userIds: string[];
    }) =>
      runBulkAction({
        items: agents,
        describe: (agent) => agent.name,
        run: async (agent) => {
          const response = await updateA2aRemoteAgent({
            path: { id: agent.id },
            body: {
              scope,
              teams: scope === "team" ? teamIds : [],
              users: scope === "personal" ? userIds : [],
            },
          });
          if (response.error) throw response.error;
          return response.data;
        },
      }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: a2aRemoteAgentQueryKeys.all });
    },
  });
}

export function useDeleteA2aRemoteAgent(options?: { notify?: boolean }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const response = await deleteA2aRemoteAgent({ path: { id } });
      if (response.error) {
        handleApiError(response.error);
        throw new Error("Failed to delete outbound A2A agent");
      }
      return response.data;
    },
    onSuccess: () => {
      if (options?.notify !== false) {
        toast.success("External A2A agent removed");
      }
      queryClient.invalidateQueries({ queryKey: a2aRemoteAgentQueryKeys.all });
    },
  });
}

export function useAgentA2aDelegations(agentId: string | undefined) {
  return useQuery({
    queryKey: a2aRemoteAgentQueryKeys.assignments(agentId ?? ""),
    queryFn: async () => {
      if (!agentId) return [];
      const response = await getAgentA2aDelegations({ path: { agentId } });
      throwOnApiError(response.error);
      return response.data ?? [];
    },
    enabled: Boolean(agentId),
  });
}

export function useSyncAgentA2aDelegations() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      agentId,
      connectionIds,
    }: {
      agentId: string;
      connectionIds: string[];
    }) => {
      const response = await syncAgentA2aDelegations({
        path: { agentId },
        body: { connectionIds },
      });
      if (response.error) {
        handleApiError(response.error);
        throw new Error("Failed to update external A2A subagents");
      }
      return response.data;
    },
    onSuccess: (_, variables) => {
      toast.success("External A2A subagents updated");
      queryClient.invalidateQueries({
        queryKey: a2aRemoteAgentQueryKeys.assignments(variables.agentId),
      });
      queryClient.invalidateQueries({
        queryKey: ["agents", variables.agentId, "tools"],
      });
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });
}
