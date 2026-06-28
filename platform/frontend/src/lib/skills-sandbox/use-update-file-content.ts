import { archestraApiSdk } from "@archestra/shared";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "@/lib/utils";

const { updateSkillSandboxArtifactContent } = archestraApiSdk;

/**
 * Overwrite a row-backed text file's content (the Files-panel editor, the REST
 * analog of saving project instructions). Returns true on success, null on a
 * handled API error. Cache refresh is the caller's concern: the preview re-reads
 * its own bytes after a save, and the owning file list (whose size/order may
 * change) is invalidated by the panel via `onSaved`.
 */
export function useUpdateFileContent() {
  return useMutation({
    mutationFn: async (params: { fileId: string; content: string }) => {
      const { error } = await updateSkillSandboxArtifactContent({
        path: { artifactId: params.fileId },
        body: { content: params.content },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return true;
    },
    onSuccess: (ok) => {
      if (ok) toast.success("File saved");
    },
  });
}
