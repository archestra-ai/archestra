import { archestraApiSdk } from "@archestra/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { reportApiError } from "@/lib/utils/api";

export type TransferResourceKind = keyof typeof transfers;

export function useTransferResourceOwnership(kind: TransferResourceKind) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ownerId }: { id: string; ownerId: string }) => {
      const { data, error } = await transfers[kind]({
        path: { id },
        body: { ownerId },
      });
      if (error) throw reportApiError(error);
      return data;
    },
    onSuccess: () => {
      for (const key of invalidationKeys[kind])
        queryClient.invalidateQueries({ queryKey: [key] });
      toast.success("Ownership transferred");
    },
  });
}

const transfers = {
  skill: archestraApiSdk.transferSkillOwnership,
  plugin: archestraApiSdk.transferPluginOwnership,
  project: archestraApiSdk.transferProjectOwnership,
  app: archestraApiSdk.transferAppOwnership,
  catalog: archestraApiSdk.transferMcpCatalogOwnership,
  remoteAgent: archestraApiSdk.transferRemoteAgentOwnership,
};
const invalidationKeys: Record<TransferResourceKind, string[]> = {
  skill: ["skills", "agent-skills"],
  plugin: ["plugins"],
  project: ["projects"],
  app: ["apps", "mcp-catalog", "mcp-servers"],
  catalog: ["mcp-catalog", "mcp-servers"],
  remoteAgent: ["a2a-remote-agents", "agent-catalog"],
};
