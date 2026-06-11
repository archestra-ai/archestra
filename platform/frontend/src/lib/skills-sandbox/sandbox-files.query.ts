import { archestraApiSdk } from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { handleApiError } from "@/lib/utils";

const { getSkillSandboxConversationArtifacts, getSkillSandboxFiles } =
  archestraApiSdk;

/** Surface A: artifacts produced in the current conversation. */
export function useConversationArtifacts(conversationId: string | undefined) {
  return useQuery({
    queryKey: ["conversation-artifacts", conversationId],
    enabled: !!conversationId,
    queryFn: async () => {
      const { data, error } = await getSkillSandboxConversationArtifacts({
        path: { conversationId: conversationId as string },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
  });
}

/** Surface B: the user's whole PFS; polled so folder hand-edits appear. */
export function useUserSandboxFiles() {
  return useQuery({
    queryKey: ["sandbox-files", "all"],
    refetchInterval: 5000,
    queryFn: async () => {
      const { data, error } = await getSkillSandboxFiles();
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
  });
}
