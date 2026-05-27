"use client";

import { archestraApiSdk, type archestraApiTypes } from "@shared";
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
type UploadResult =
  archestraApiTypes.UploadKnowledgeFilesResponses["200"]["results"][number];

const ACTIVE_STATUSES = new Set(["pending", "processing"]);

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
      const hasActive = query.state.data?.data.some((file) => {
        if (ACTIVE_STATUSES.has(file.processingStatus)) return true;
        return ACTIVE_STATUSES.has(file.embeddingStatus);
      });
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
      if (ACTIVE_STATUSES.has(file.processingStatus)) return 3000;
      if (ACTIVE_STATUSES.has(file.embeddingStatus)) return 3000;
      return false;
    },
  });
}

export function useKnowledgeFileUploadConfig() {
  return useQuery({
    queryKey: ["knowledge-files", "config"],
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
    mutationFn: async (params: {
      files: File[];
      visibility: archestraApiTypes.UploadKnowledgeFilesData["body"]["visibility"];
      teamIds: string[];
      agentIds: string[];
    }) => {
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
    mutationFn: async ({
      attachmentId,
      body,
    }: {
      attachmentId: string;
      body: archestraApiTypes.PromoteChatAttachmentToKnowledgeFileData["body"];
    }) => {
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
    mutationFn: async ({
      fileId,
      body,
    }: {
      fileId: string;
      body: archestraApiTypes.UpdateKnowledgeFileData["body"];
    }) => {
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
  });
}

export function useDeleteKnowledgeFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (fileId: string) => {
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
  });
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
      resolve(dataUrl.split(",")[1]);
    };
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}
