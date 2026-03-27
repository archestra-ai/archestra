import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "@/lib/utils";

// TODO: Replace with generated SDK methods after running `pnpm codegen:api-client`
async function apiFetch(url: string, init?: RequestInit) {
  return fetch(url, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
}

export const agentScheduleTriggerKeys = {
  all: ["agent-schedule-triggers"] as const,
  list: (agentId?: string) =>
    [...agentScheduleTriggerKeys.all, "list", agentId] as const,
  detail: (id: string) =>
    [...agentScheduleTriggerKeys.all, "detail", id] as const,
};

type AgentScheduleTrigger = {
  id: string;
  agentId: string;
  organizationId: string;
  name: string;
  triggerType: "cron" | "interval" | "one_time";
  enabled: boolean;
  cronExpression: string | null;
  intervalSeconds: number | null;
  scheduledAt: string | null;
  message: string;
  lastExecutedAt: string | null;
  nextExecutionAt: string | null;
  executionCount: number;
  lastError: string | null;
  misfireGraceSeconds: number;
  createdAt: string;
  updatedAt: string;
};

export function useAgentScheduleTriggers(agentId?: string) {
  return useQuery({
    queryKey: agentScheduleTriggerKeys.list(agentId),
    queryFn: async () => {
      const url = agentId
        ? `/api/agent-schedule-triggers?agentId=${agentId}`
        : "/api/agent-schedule-triggers";
      const res = await apiFetch(url);
      if (!res.ok) {
        handleApiError(await res.json());
        return [];
      }
      return (await res.json()) as AgentScheduleTrigger[];
    },
  });
}

export function useAgentScheduleTrigger(id: string) {
  return useQuery({
    queryKey: agentScheduleTriggerKeys.detail(id),
    queryFn: async () => {
      const res = await apiFetch(`/api/agent-schedule-triggers/${id}`);
      if (!res.ok) {
        handleApiError(await res.json());
        return null;
      }
      return (await res.json()) as AgentScheduleTrigger;
    },
    enabled: !!id,
  });
}

export function useCreateAgentScheduleTrigger() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      agentId: string;
      name: string;
      triggerType: "cron" | "interval" | "one_time";
      enabled?: boolean;
      cronExpression?: string;
      intervalSeconds?: number;
      scheduledAt?: string;
      message?: string;
      misfireGraceSeconds?: number;
    }) => {
      const res = await apiFetch("/api/agent-schedule-triggers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        handleApiError(await res.json());
        return null;
      }
      return (await res.json()) as AgentScheduleTrigger;
    },
    onSuccess: (data) => {
      if (!data) return;
      toast.success("Schedule trigger created");
      queryClient.invalidateQueries({
        queryKey: agentScheduleTriggerKeys.all,
      });
    },
  });
}

export function useUpdateAgentScheduleTrigger() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      id: string;
      body: {
        name?: string;
        triggerType?: "cron" | "interval" | "one_time";
        enabled?: boolean;
        cronExpression?: string;
        intervalSeconds?: number;
        scheduledAt?: string;
        message?: string;
        misfireGraceSeconds?: number;
      };
    }) => {
      const res = await apiFetch(`/api/agent-schedule-triggers/${params.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params.body),
      });
      if (!res.ok) {
        handleApiError(await res.json());
        return null;
      }
      return (await res.json()) as AgentScheduleTrigger;
    },
    onSuccess: (data) => {
      if (!data) return;
      toast.success("Schedule trigger updated");
      queryClient.invalidateQueries({
        queryKey: agentScheduleTriggerKeys.all,
      });
    },
  });
}

export function useDeleteAgentScheduleTrigger() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await apiFetch(`/api/agent-schedule-triggers/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        handleApiError(await res.json());
        return null;
      }
      return await res.json();
    },
    onSuccess: (data) => {
      if (!data) return;
      toast.success("Schedule trigger deleted");
      queryClient.invalidateQueries({
        queryKey: agentScheduleTriggerKeys.all,
      });
    },
  });
}

export function useToggleAgentScheduleTrigger() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { id: string; enable: boolean }) => {
      const action = params.enable ? "enable" : "disable";
      const res = await apiFetch(
        `/api/agent-schedule-triggers/${params.id}/${action}`,
        { method: "POST" },
      );
      if (!res.ok) {
        handleApiError(await res.json());
        return null;
      }
      return (await res.json()) as AgentScheduleTrigger;
    },
    onSuccess: (data) => {
      if (!data) return;
      toast.success(
        `Schedule trigger ${data.enabled ? "enabled" : "disabled"}`,
      );
      queryClient.invalidateQueries({
        queryKey: agentScheduleTriggerKeys.all,
      });
    },
  });
}

export function useManualTriggerAgentSchedule() {
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await apiFetch(`/api/agent-schedule-triggers/${id}/trigger`, {
        method: "POST",
      });
      if (!res.ok) {
        handleApiError(await res.json());
        return null;
      }
      return await res.json();
    },
    onSuccess: (data) => {
      if (!data) return;
      toast.success("Agent triggered successfully");
    },
  });
}
