import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { reportApiError, throwOnApiError } from "@/lib/utils";

export function useClaudeCodeAccount(agentId: string, polling = false) {
  const client = useQueryClient();
  return useQuery({
    queryKey: accountKey(agentId),
    enabled: Boolean(agentId),
    refetchInterval: polling
      ? (query) => {
          const state = query.state.data?.state;
          return state === "starting" || state === "connecting" ? 1000 : 2000;
        }
      : false,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getClaudeCodeAccount({
        path: { id: agentId },
      });
      throwOnApiError(error, { toastOnError: false });
      const previous = client.getQueryData<
        archestraApiTypes.GetClaudeCodeAccountResponses["200"]
      >(accountKey(agentId));
      if (data?.state !== previous?.state) {
        void client.invalidateQueries({
          queryKey: ["agents", agentId, "runtime", "preflight"],
        });
        if (data?.state !== "connected")
          client.removeQueries({ queryKey: modelsKey(agentId) });
      }
      return data;
    },
  });
}

export function useClaudeCodeModels(agentId: string, connected: boolean) {
  return useQuery({
    queryKey: modelsKey(agentId),
    enabled: Boolean(agentId) && connected,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getClaudeCodeModels({
        path: { id: agentId },
      });
      throwOnApiError(error, { toastOnError: false });
      return data?.models ?? [];
    },
  });
}

export function useClaudeCodeSignIn(agentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (
      body:
        | archestraApiTypes.CompleteClaudeCodeSignInData["body"]
        | archestraApiTypes.StartClaudeCodeSignInData["body"]
        | undefined,
    ) => {
      const request = { path: { id: agentId } };
      const { data, error } =
        body && "flowId" in body
          ? await archestraApiSdk.completeClaudeCodeSignIn({ ...request, body })
          : await archestraApiSdk.startClaudeCodeSignIn({
              ...request,
              body: body ?? {},
            });
      if (error) throw reportApiError(error);
      return data;
    },
    onSuccess: async (data) => {
      await client.cancelQueries({ queryKey: accountKey(agentId) });
      client.setQueryData(accountKey(agentId), data);
      void client.invalidateQueries({
        queryKey: ["agents", agentId, "runtime", "preflight"],
      });
    },
  });
}

export function useDisconnectClaudeCodeAccount(agentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await archestraApiSdk.disconnectClaudeCodeAccount(
        { path: { id: agentId } },
      );
      if (error) throw reportApiError(error);
      return data;
    },
    onSuccess: async (data) => {
      await client.cancelQueries({ queryKey: accountKey(agentId) });
      client.setQueryData(accountKey(agentId), data);
      client.removeQueries({ queryKey: modelsKey(agentId) });
      void client.invalidateQueries({
        queryKey: ["agents", agentId, "runtime", "preflight"],
      });
      toast.success("Claude Code disconnected");
    },
  });
}

const accountKey = (agentId: string) =>
  ["claude-code-account", agentId] as const;
const modelsKey = (agentId: string) => ["claude-code-models", agentId] as const;
