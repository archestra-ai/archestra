"use client";

import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "@/lib/utils";

const {
  deleteKnowledgeFile,
  getKnowledgeFile,
  getKnowledgeFiles,
  getKnowledgeFileUploadConfig,
  promoteChatAttachmentToKnowledgeFile,
  updateKnowledgeFile,
  uploadKnowledgeFiles,
} = archestraApiSdk;

export type KnowledgeFile =
  archestraApiTypes.GetKnowledgeFilesResponses["200"]["data"][number];

type KnowledgeFilesQuery = NonNullable<
  archestraApiTypes.GetKnowledgeFilesData["query"]
>;
type KnowledgeFilesPaginatedParams = Pick<
  KnowledgeFilesQuery,
  "limit" | "offset" | "search"
>;
type KnowledgeFileStatusFields = Pick<
  KnowledgeFile,
  "processingStatus" | "embeddingStatus"
>;
type KnowledgeFileStatus =
  KnowledgeFileStatusFields[keyof KnowledgeFileStatusFields];
type UploadKnowledgeFilesParams = Omit<
  archestraApiTypes.UploadKnowledgeFilesData["body"],
  "files"
> & {
  files: File[];
};
type PromoteChatAttachmentParams = {
  attachmentId: archestraApiTypes.PromoteChatAttachmentToKnowledgeFileData["path"]["id"];
  body: archestraApiTypes.PromoteChatAttachmentToKnowledgeFileData["body"];
};
type UpdateKnowledgeFileParams = {
  fileId: archestraApiTypes.UpdateKnowledgeFileData["path"]["fileId"];
  body: archestraApiTypes.UpdateKnowledgeFileData["body"];
};
type DeleteKnowledgeFileParams =
  archestraApiTypes.DeleteKnowledgeFileData["path"]["fileId"];
type UploadResult =
  archestraApiTypes.UploadKnowledgeFilesResponses["200"]["results"][number];

const ACTIVE_STATUSES = new Set<KnowledgeFileStatus>(["pending", "processing"]);

export function useKnowledgeFilesPaginated(
  params: KnowledgeFilesPaginatedParams,
) {
  return useQuery({
    queryKey: ["knowledge-files", "paginated", params],
    placeholderData: (previousData) => previousData,
    queryFn: async () => {
      const { data, error } = await getKnowledgeFiles({ query: params });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    refetchInterval: (query) => {
      const hasActive = query.state.data?.data.some(
        hasActiveKnowledgeFileStatus,
      );
      return hasActive ? 3000 : false;
    },
  });
}

export function useKnowledgeFile(fileId: string) {
  return useQuery({
    queryKey: ["knowledge-files", fileId],
    queryFn: async () => {
      const { data, error } = await getKnowledgeFile({ path: { fileId } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    enabled: Boolean(fileId),
    refetchInterval: (query) => {
      const file = query.state.data;
      if (!file) return false;
      return hasActiveKnowledgeFileStatus(file) ? 3000 : false;
    },
  });
}

export function useKnowledgeFileUploadConfig() {
  return useQuery({
    queryKey: ["knowledge-files", "config"],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await getKnowledgeFileUploadConfig();
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
  });
}

export function useUploadKnowledgeFiles() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: UploadKnowledgeFilesParams) => {
      const files = await Promise.all(
        params.files.map(async (file) => ({
          name: file.name,
          mimeType: file.type,
          content: await fileToBase64(file),
        })),
      );

      const { data, error } = await uploadKnowledgeFiles({
        body: {
          files,
          visibility: params.visibility,
          teamIds: params.teamIds,
          agentIds: params.agentIds,
        },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["knowledge-files"] });
      showUploadResultToasts(data.results);
    },
    onError: () => {
      toast.error("Failed to upload files");
    },
  });
}

export function usePromoteChatAttachmentToKnowledgeFile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ attachmentId, body }: PromoteChatAttachmentParams) => {
      const { data, error } = await promoteChatAttachmentToKnowledgeFile({
        path: { id: attachmentId },
        body,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["knowledge-files"] });
      if (data.status === "duplicate") {
        toast.info("Attachment is already saved to Knowledge");
        return;
      }
      showUploadResultToasts([data]);
    },
    onError: () => {
      toast.error("Failed to save attachment to Knowledge");
    },
  });
}

export function useUpdateKnowledgeFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ fileId, body }: UpdateKnowledgeFileParams) => {
      const { data, error } = await updateKnowledgeFile({
        path: { fileId },
        body,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["knowledge-files"] });
      toast.success("Knowledge file updated");
    },
    onError: () => {
      toast.error("Failed to update Knowledge file");
    },
  });
}

export function useDeleteKnowledgeFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (fileId: DeleteKnowledgeFileParams) => {
      const { data, error } = await deleteKnowledgeFile({ path: { fileId } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["knowledge-files"] });
      toast.success("Knowledge file deleted");
    },
    onError: () => {
      toast.error("Failed to delete Knowledge file");
    },
  });
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function hasActiveKnowledgeFileStatus(file: KnowledgeFileStatusFields) {
  return (
    ACTIVE_STATUSES.has(file.processingStatus) ||
    ACTIVE_STATUSES.has(file.embeddingStatus)
  );
}

function showUploadResultToasts(results: UploadResult[]) {
  const created = results.filter((result) => result.status === "created");
  const duplicates = results.filter((result) => result.status === "duplicate");
  const skipped = results.filter(
    (result) =>
      result.status === "unsupported" ||
      result.status === "too_large" ||
      result.status === "extraction_failed" ||
      result.status === "failed",
  );

  if (created.length > 0) {
    toast.success(
      `${created.length} file${created.length > 1 ? "s" : ""} uploaded and queued for indexing`,
    );
  }
  if (duplicates.length > 0) {
    toast.warning(
      `${duplicates.length} file${duplicates.length > 1 ? "s already exist" : " already exists"}`,
    );
  }
  if (skipped.length > 0) {
    toast.error(
      `${skipped.length} file${skipped.length > 1 ? "s" : ""} skipped`,
    );
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      resolve(dataUrl.substring(dataUrl.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}
