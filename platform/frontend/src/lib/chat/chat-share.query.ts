import { archestraApiSdk } from "@archestra/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { callApi } from "@/lib/chat/api-call";

const { forkChatConversation, forkSharedConversation } = archestraApiSdk;

export function useForkSharedConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      shareId,
      agentId,
    }: {
      shareId: string;
      agentId: string;
    }) =>
      callApi(
        () => forkSharedConversation({ path: { shareId }, body: { agentId } }),
        null,
      ),
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      if (data.projectId) {
        queryClient.invalidateQueries({
          queryKey: ["projects", data.projectId, "conversations"],
        });
      }
    },
  });
}

export function useForkConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      conversationId,
      agentId,
    }: {
      conversationId: string;
      agentId: string;
    }) =>
      callApi(
        () =>
          forkChatConversation({
            path: { id: conversationId },
            body: { agentId },
          }),
        null,
      ),
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      if (data.projectId) {
        queryClient.invalidateQueries({
          queryKey: ["projects", data.projectId, "conversations"],
        });
      }
    },
  });
}
