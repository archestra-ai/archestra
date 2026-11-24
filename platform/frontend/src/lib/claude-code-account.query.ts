import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { reportApiError, throwOnApiError } from "@/lib/utils/api";

export function useMyClaudeCodeAccount(enabled = true, polling = false) {
  const client = useQueryClient();
  return useQuery({
    queryKey: myAccountKey,
    enabled,
    refetchInterval: polling
      ? (query) => {
          const state = query.state.data?.state;
          return state === "starting" || state === "connecting" ? 1000 : 2000;
        }
      : false,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getMyClaudeCodeAccount();
      throwOnApiError(error, { toastOnError: false });
      const previous =
        client.getQueryData<
          archestraApiTypes.GetMyClaudeCodeAccountResponses["200"]
        >(myAccountKey);
      if (data?.state !== previous?.state) {
        void client.invalidateQueries({ queryKey: ["agents"] });
        if (data?.state !== "connected")
          client.removeQueries({ queryKey: ["claude-code-models"] });
      }
      return data;
    },
  });
}

export function useMyClaudeCodeSignIn() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (
      body:
        | archestraApiTypes.CompleteMyClaudeCodeSignInData["body"]
        | archestraApiTypes.StartMyClaudeCodeSignInData["body"]
        | undefined,
    ) => {
      const { data, error } =
        body && "flowId" in body
          ? await archestraApiSdk.completeMyClaudeCodeSignIn({ body })
          : await archestraApiSdk.startMyClaudeCodeSignIn({
              body: body ?? {},
            });
      if (error) throw reportApiError(error);
      return data;
    },
    onSuccess: async (data) => {
      await client.cancelQueries({ queryKey: myAccountKey });
      client.setQueryData(myAccountKey, data);
      if (data?.state === "connected") {
        void client.invalidateQueries({ queryKey: ["claude-code-account"] });
        void client.invalidateQueries({ queryKey: ["claude-code-models"] });
        void client.invalidateQueries({ queryKey: ["agents"] });
      }
    },
  });
}

export function useDisconnectMyClaudeCodeAccount() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } =
        await archestraApiSdk.disconnectMyClaudeCodeAccount();
      if (error) throw reportApiError(error);
      return data;
    },
    onSuccess: async (data) => {
      await client.cancelQueries({ queryKey: myAccountKey });
      client.setQueryData(myAccountKey, data);
      client.removeQueries({ queryKey: ["claude-code-models"] });
      void client.invalidateQueries({ queryKey: ["claude-code-account"] });
      void client.invalidateQueries({ queryKey: ["agents"] });
      toast.success("Claude Code disconnected");
    },
  });
}

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
      if (data?.state === "connected") {
        void client.invalidateQueries({ queryKey: ["claude-code-account"] });
        void client.invalidateQueries({ queryKey: ["claude-code-models"] });
        void client.invalidateQueries({ queryKey: ["agents"] });
      }
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
      client.removeQueries({ queryKey: ["claude-code-models"] });
      void client.invalidateQueries({ queryKey: ["claude-code-account"] });
      void client.invalidateQueries({ queryKey: ["agents"] });
      toast.success("Claude Code disconnected");
    },
  });
}

const myAccountKey = ["claude-code-account", "me"] as const;
const accountKey = (agentId: string) =>
  ["claude-code-account", agentId] as const;
const modelsKey = (agentId: string) => ["claude-code-models", agentId] as const;
