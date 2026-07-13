import { archestraApiSdk, type ChatMessageFeedback } from "@archestra/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { callApi } from "@/lib/chat/api-call";
import { handleApiError, toApiError } from "@/lib/utils";

const { updateChatMessage, setChatMessageFeedback } = archestraApiSdk;

export function useUpdateChatMessage(conversationId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      messageId,
      partIndex,
      text,
      deleteSubsequentMessages,
    }: {
      messageId: string;
      partIndex: number;
      text: string;
      deleteSubsequentMessages?: boolean;
    }) =>
      callApi(
        () =>
          updateChatMessage({
            path: { id: messageId },
            body: { partIndex, text, deleteSubsequentMessages },
          }),
        null,
      ),
    onSuccess: () => {
      if (!conversationId) {
        return;
      }

      queryClient.invalidateQueries({
        queryKey: ["conversation", conversationId],
      });
    },
  });
}

/**
 * Set or clear the owner's thumbs verdict on an assistant message. Throws on
 * API errors (unlike callApi-based mutations) so callers can roll back an
 * optimistic update in onError. Invalidation uses the per-call variables, so
 * switching conversations mid-flight cannot retarget it.
 */
export function useSetChatMessageFeedback() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      messageId,
      conversationId,
      feedback,
    }: {
      messageId: string;
      conversationId: string;
      feedback: ChatMessageFeedback | null;
    }) => {
      const { data, error } = await setChatMessageFeedback({
        path: { id: messageId },
        body: { conversationId, feedback },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }

      return data;
    },
    onSettled: (_data, _error, { conversationId }) => {
      queryClient.invalidateQueries({
        queryKey: ["conversation", conversationId],
      });
    },
  });
}
