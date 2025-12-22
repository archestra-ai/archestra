import { archestraApiSdk } from "@shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

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
        const errorMessage =
          typeof error.error === "string"
            ? error.error
            : (error.error as { message?: string })?.message ||
              "Failed to update message";
        throw new Error(errorMessage);
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["conversation", conversationId],
      });
    },
    onError: (error: Error) => {
      console.error("Update message error:", error);
      toast.error(error.message);
    },
  });
}
