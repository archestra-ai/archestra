import { archestraApiSdk } from "@shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { handleApiError } from "./utils";

const { updateChatMessage } = archestraApiSdk;

export function useUpdateChatMessage(conversationId: string) {
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
    }) => {
      const { data, error } = await updateChatMessage({
        path: { id: messageId },
        body: { partIndex, text, deleteSubsequentMessages },
      });

      if (error) {
        handleApiError(error);
        return null;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["conversation", conversationId],
      });
    },
  });
}
