import { archestraApiClient, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { handleApiError } from "@/lib/utils";

// Custom API calls since they are not in the generated SDK yet
const agentScheduleApi = {
  getAgentSchedules: (query?: { agentId?: string }) => 
    archestraApiClient.get<any[]>({ url: "/api/agent-schedules", query }),
  createAgentSchedule: (body: any) =>
    archestraApiClient.post<any>({ url: "/api/agent-schedules", body }),
  updateAgentSchedule: (id: string, body: any) =>
    archestraApiClient.patch<any>({ url: `/api/agent-schedules/${id}`, body }),
  deleteAgentSchedule: (id: string) =>
    archestraApiClient.delete<any>({ url: `/api/agent-schedules/${id}` }),
};

export function useAgentSchedules(agentId?: string) {
  return useQuery({
    queryKey: ["agent-schedules", { agentId }],
    queryFn: async () => {
      const response = await agentScheduleApi.getAgentSchedules(agentId ? { agentId } : undefined);
      return response.data ?? [];
    },
  });
}

export function useCreateAgentSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: any) => {
      const { data: responseData, error } = await agentScheduleApi.createAgentSchedule(data);
      if (error) handleApiError(error);
      return responseData;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent-schedules"] });
    },
  });
}

export function useUpdateAgentSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      const { data: responseData, error } = await agentScheduleApi.updateAgentSchedule(id, data);
      if (error) handleApiError(error);
      return responseData;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent-schedules"] });
    },
  });
}

export function useDeleteAgentSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await agentScheduleApi.deleteAgentSchedule(id);
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent-schedules"] });
    },
  });
}
