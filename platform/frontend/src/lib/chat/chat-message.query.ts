import { archestraApiSdk } from "@archestra/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { callApi } from "@/lib/chat/api-call";

const { updateChatMessage } = archestraApiSdk;

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
