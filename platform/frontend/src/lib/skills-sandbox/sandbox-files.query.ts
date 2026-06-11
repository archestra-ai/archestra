import { archestraApiSdk } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "@/lib/utils";

const {
  createSkillSandboxFolder,
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

/** Create a PFS folder; the files listing refreshes on success. */
export function useCreateSandboxFolder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ name }: { name: string }) => {
      const { data, error } = await createSkillSandboxFolder({
        body: { name },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (folder) => {
      if (!folder) return;
      toast.success(`Folder "${folder.name}" created`);
      queryClient.invalidateQueries({ queryKey: ["sandbox-files"] });
    },
  });
}
