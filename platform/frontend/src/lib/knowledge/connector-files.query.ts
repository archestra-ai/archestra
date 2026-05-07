"use client";

import { type archestraApiTypes, archestraApiClient as client } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

export type UploadedFile =
  archestraApiTypes.GetConnectorFilesResponses["200"]["data"][number];

type UploadResult =
  archestraApiTypes.UploadConnectorFilesResponses["200"]["results"][number];

type PaginatedFilesResponse = {
  data: UploadedFile[];
  pagination: {
    currentPage: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
};

const ACTIVE_STATUSES = new Set(["pending", "processing"]);

export function useConnectorFilesPaginated(params: {
  connectorId: string;
  limit: number;
  offset: number;
  search?: string;
}) {
  return useQuery({
    queryKey: [
      "connector-files",
      params.connectorId,
      params.limit,
      params.offset,
      params.search ?? "",
    ],
    queryFn: async () => {
      const response = await client.get({
        url: "/api/connectors/{id}/files",
        path: { id: params.connectorId },
        query: {
          limit: params.limit,
          offset: params.offset,
          ...(params.search ? { search: params.search } : {}),
        },
      });
      const data = response.data as PaginatedFilesResponse | undefined;
      return (
        data ?? {
          data: [],
          pagination: {
            currentPage: 1,
            limit: params.limit,
            total: 0,
            totalPages: 0,
            hasNext: false,
            hasPrev: false,
          },
        }
      );
    },
    enabled: Boolean(params.connectorId),
  });
}

export function useConnectorFile(connectorId: string, fileId: string) {
  return useQuery({
    queryKey: ["connector-file", connectorId, fileId],
    queryFn: async () => {
      const response = await client.get({
        url: "/api/connectors/{id}/files/{fileId}" as "/api/connectors/{id}/files/{fileId}",
        path: { id: connectorId, fileId },
      });
      return (response.data ?? null) as UploadedFile | null;
    },
    enabled: Boolean(connectorId) && Boolean(fileId),
    refetchInterval: (query) => {
      const file = query.state.data as UploadedFile | null | undefined;
      if (!file) return false;
      const processingStatus = file.processingStatus as string | undefined;
      if (processingStatus && ACTIVE_STATUSES.has(processingStatus))
        return 3000;
      if (ACTIVE_STATUSES.has(file.embeddingStatus)) return 3000;
      return false;
    },
  });
}

export function useUploadConnectorFiles(connectorId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (files: File[]) => {
      const allResults: UploadResult[] = [];

      for (const file of files) {
        const content = await fileToBase64(file);
        const { data, error } = await client.post({
          url: "/api/connectors/{id}/files",
          path: { id: connectorId },
          body: {
            files: [{ name: file.name, mimeType: file.type, content }],
          },
        });

        if (error || !data) {
          const detail =
            typeof error === "object" && error !== null && "message" in error
              ? (error as { message: string }).message
              : typeof error === "string"
                ? error
                : "";
          throw new Error(
            `Upload failed for ${file.name}${detail ? `: ${detail}` : ""}`,
          );
        }

        const result = data as { results: UploadResult[] };
        allResults.push(...result.results);
      }

      return { results: allResults };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({
        queryKey: ["connector-files", connectorId],
      });
      queryClient.invalidateQueries({
        queryKey: ["connector-file", connectorId],
      });
      queryClient.invalidateQueries({ queryKey: ["connector", connectorId] });

      const results = data?.results ?? [];
      const created = results.filter((r) => r.status === "created").length;
      const duplicates = results.filter((r) => r.status === "duplicate").length;
      const unsupported = results.filter(
        (r) => r.status === "unsupported" || r.status === "too_large",
      ).length;
      const extractionFailed = results.filter(
        (r) => r.status === "extraction_failed",
      ).length;

      if (created > 0) {
        toast.success(
          `${created} file${created > 1 ? "s" : ""} uploaded and queued for indexing`,
        );
      }
      if (duplicates > 0) {
        toast.warning(
          `${duplicates} file${duplicates > 1 ? "s" : ""} already exist in this connector`,
        );
      }
      if (unsupported > 0) {
        toast.error(
          `${unsupported} file${unsupported > 1 ? "s" : ""} skipped (unsupported type or too large)`,
        );
      }
      if (extractionFailed > 0) {
        toast.error(
          `${extractionFailed} file${extractionFailed > 1 ? "s" : ""} failed to extract text — the file may be corrupted or use unsupported formatting`,
        );
      }
    },
    onError: () => {
      toast.error("Failed to upload files");
    },
  });
}

export function useDeleteConnectorFile(connectorId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (fileId: string) => {
      await client.delete({
        url: "/api/connectors/{id}/files/{fileId}",
        path: { id: connectorId, fileId },
      });
    },
    onSuccess: (_data, fileId) => {
      queryClient.invalidateQueries({
        queryKey: ["connector-files", connectorId],
      });
      queryClient.invalidateQueries({
        queryKey: ["connector-file", connectorId, fileId],
      });
      queryClient.invalidateQueries({ queryKey: ["connector", connectorId] });
      toast.success("File deleted");
    },
    onError: () => {
      toast.error("Failed to delete file");
    },
  });
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
