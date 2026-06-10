import { archestraApiSdk } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "@/lib/utils";

const {
  getAgentVersions,
  getAgentVersion,
  getAgentVersionDiff,
  restoreAgentVersion,
} = archestraApiSdk;

export function useAgentVersions(agentId: string) {
  return useQuery({
    queryKey: ["agentVersions", agentId],
    queryFn: async () => {
      const { data, error } = await getAgentVersions({
        path: { id: agentId },
      });
      if (error) {
        handleApiError(error);
        return { data: [], total: 0 };
      }
      return data ?? { data: [], total: 0 };
    },
  });
}

export function useAgentVersion(agentId: string, versionId: string | null) {
  return useQuery({
    queryKey: ["agentVersion", agentId, versionId],
    queryFn: async () => {
      if (!versionId) return null;
      const { data, error } = await getAgentVersion({
        path: { id: agentId, versionId },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    enabled: !!versionId,
  });
}

export function useAgentVersionDiff(
  agentId: string,
  versionId: string | null,
  against: string | null,
) {
  return useQuery({
    queryKey: ["agentVersionDiff", agentId, versionId, against],
    queryFn: async () => {
      if (!versionId || !against) return null;
      const { data, error } = await getAgentVersionDiff({
        path: { id: agentId, versionId },
        query: { against },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    enabled: !!versionId && !!against,
  });
}

export function useRestoreAgentVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      agentId,
      versionId,
    }: {
      agentId: string;
      versionId: string;
    }) => {
      const { data, error } = await restoreAgentVersion({
        path: { id: agentId, versionId },
        body: {},
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    onSuccess: (data, { agentId }) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["agentVersions", agentId] });
      toast.success("Prompt restored successfully");
    },
  });
}
