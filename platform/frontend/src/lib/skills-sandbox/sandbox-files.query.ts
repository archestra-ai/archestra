import { archestraApiSdk } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "@/lib/utils";

const {
  deleteSkillSandboxArtifact,
  getSkillSandboxConversationArtifacts,
  getSkillSandboxFiles,
} = archestraApiSdk;

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

/** Surface B: the user's whole PFS; polled so out-of-band changes appear. */
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

/** Delete a persistent file; the files listing refreshes on success. */
export function useDeleteSandboxFile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const { error } = await deleteSkillSandboxArtifact({
        path: { artifactId: id },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return true;
    },
    onSuccess: (ok) => {
      if (!ok) return;
      toast.success("File deleted");
      queryClient.invalidateQueries({ queryKey: ["sandbox-files"] });
      queryClient.invalidateQueries({ queryKey: ["conversation-artifacts"] });
      // project pages list the same files through their own endpoint
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}
