import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { type BulkOutcome, toBulkOutcome } from "@/lib/bulk-action";
import { useAllMatching } from "@/lib/hooks/use-all-matching";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils";

const {
  bulkDeleteKnowledgeDirectories,
  bulkDeleteKnowledgeFiles,
  bulkUpdateKnowledgeDirectories,
  bulkUpdateKnowledgeFiles,
  getKnowledgeFiles,
  uploadKnowledgeFile,
  promoteAttachmentToKnowledgeFile,
  deleteKnowledgeFile,
  updateKnowledgeFile,
  indexKnowledgeFiles,
  getKnowledgeDirectories,
  createKnowledgeDirectory,
  updateKnowledgeDirectory,
  deleteKnowledgeDirectory,
} = archestraApiSdk;

export type KnowledgeFile = NonNullable<
  archestraApiTypes.GetKnowledgeFilesResponses["200"]
>["data"][number];

export type KnowledgeDirectory = NonNullable<
  archestraApiTypes.GetKnowledgeDirectoriesResponses["200"]
>[number];

/** Sentinel for "the repository root", which is a filter, not the absence of one. */
export const ROOT_DIRECTORY = "root";

const FILES_KEY = "knowledge-files";
const DIRECTORIES_KEY = "knowledge-directories";

// ===== Queries =====

export function useKnowledgeFiles(params: {
  limit: number;
  offset: number;
  directoryId?: string;
  search?: string;
  /** Serialized `?labels=` filter; resolved server-side. */
  labels?: string;
}) {
  return useQuery({
    queryKey: [FILES_KEY, params],
    queryFn: async () => {
      const { data, error } = await getKnowledgeFiles({ query: params });
      throwOnApiError(error);
      return data ?? null;
    },
    placeholderData: (previous) => previous,
  });
}

/**
 * Every document matching the current directory and search, not just the page
 * in view — what backs "select all N documents that match this search query".
 *
 * Directories are not walked: they arrive whole from `useKnowledgeDirectories`,
 * so nothing about them is hidden behind a page.
 */
export function useAllMatchingKnowledgeFiles(
  params: { directoryId?: string; search?: string; labels?: string },
  options?: { enabled?: boolean },
) {
  return useAllMatching({
    queryKey: [FILES_KEY, "all-matching", params],
    enabled: options?.enabled,
    fetchPage: async ({ limit, offset }) => {
      const { data, error } = await getKnowledgeFiles({
        query: { ...params, limit, offset },
      });
      throwOnApiError(error);
      return data?.data ?? [];
    },
  });
}

/**
 * One selection, two kinds of row: documents and the directories that hold
 * them. Both bulk actions below dispatch per kind rather than making the
 * caller keep two selections.
 *
 * Deleting a directory takes its contents with it, which is why the confirm
 * copy says so.
 */
export function useBulkDeleteKnowledgeItems() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (items: readonly KnowledgeSelectionItem[]) =>
      dispatchByKind(items, {
        files: (ids) => bulkDeleteKnowledgeFiles({ body: { ids } }),
        directories: (ids) => bulkDeleteKnowledgeDirectories({ body: { ids } }),
      }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: [FILES_KEY] });
      queryClient.invalidateQueries({ queryKey: [DIRECTORIES_KEY] });
    },
  });
}

export function useBulkUpdateKnowledgeVisibility() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      items,
      visibility,
      teamIds,
    }: {
      items: readonly KnowledgeSelectionItem[];
      visibility: "org-wide" | "team-scoped" | "private";
      teamIds: string[];
    }) =>
      dispatchByKind(items, {
        files: (ids) =>
          bulkUpdateKnowledgeFiles({ body: { ids, visibility, teamIds } }),
        directories: (ids) =>
          bulkUpdateKnowledgeDirectories({
            body: { ids, visibility, teamIds },
          }),
      }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: [FILES_KEY] });
      queryClient.invalidateQueries({ queryKey: [DIRECTORIES_KEY] });
    },
  });
}

/** A ticked row, tagged with which route acts on it. */
export type KnowledgeSelectionItem = {
  kind: "file" | "directory";
  id: string;
  name: string;
};

export function useKnowledgeDirectories() {
  return useQuery({
    queryKey: [DIRECTORIES_KEY],
    queryFn: async () => {
      const { data, error } = await getKnowledgeDirectories();
      throwOnApiError(error);
      return data ?? [];
    },
  });
}

// ===== Mutations =====

export function useUploadKnowledgeFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: NonNullable<archestraApiTypes.UploadKnowledgeFileData["body"]>,
    ) => {
      const { data, error } = await uploadKnowledgeFile({ body });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [FILES_KEY] });
      queryClient.invalidateQueries({ queryKey: [DIRECTORIES_KEY] });
    },
  });
}

/**
 * Copies a file attached to a chat into the repository, so it outlives the
 * conversation it arrived in.
 */
export function usePromoteAttachmentToKnowledgeFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: NonNullable<
        archestraApiTypes.PromoteAttachmentToKnowledgeFileData["body"]
      >,
    ) => {
      const { data, error } = await promoteAttachmentToKnowledgeFile({ body });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [FILES_KEY] });
      queryClient.invalidateQueries({ queryKey: [DIRECTORIES_KEY] });
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
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [FILES_KEY] });
      queryClient.invalidateQueries({ queryKey: [DIRECTORIES_KEY] });
      toast.success("File deleted");
    },
  });
}

export function useUpdateKnowledgeFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      fileId: string;
      body: NonNullable<archestraApiTypes.UpdateKnowledgeFileData["body"]>;
    }) => {
      const { data, error } = await updateKnowledgeFile({
        path: { fileId: params.fileId },
        body: params.body,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [FILES_KEY] });
      queryClient.invalidateQueries({ queryKey: [DIRECTORIES_KEY] });
      toast.success("Document updated");
    },
  });
}

export function useIndexKnowledgeFiles() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: NonNullable<archestraApiTypes.IndexKnowledgeFilesData["body"]>,
    ) => {
      const { data, error } = await indexKnowledgeFiles({ body });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: [FILES_KEY] });
      queryClient.invalidateQueries({ queryKey: ["knowledge-bases"] });

      const indexed = data?.indexed ?? 0;
      const failed = data?.failures?.length ?? 0;
      // Partial success is the common case with a mixed selection, so the
      // toast has to report both halves rather than claiming success.
      if (failed > 0) {
        toast.warning(`${indexed} added, ${failed} could not be read`, {
          description: data?.failures?.[0]?.error,
        });
        return;
      }
      toast.success(
        indexed === 1 ? "1 document added" : `${indexed} documents added`,
      );
    },
  });
}

export function useCreateKnowledgeDirectory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: NonNullable<archestraApiTypes.CreateKnowledgeDirectoryData["body"]>,
    ) => {
      const { data, error } = await createKnowledgeDirectory({ body });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [DIRECTORIES_KEY] });
      toast.success("Directory created");
    },
  });
}

export function useUpdateKnowledgeDirectory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      directoryId: string;
      body: NonNullable<archestraApiTypes.UpdateKnowledgeDirectoryData["body"]>;
    }) => {
      const { data, error } = await updateKnowledgeDirectory({
        path: { directoryId: params.directoryId },
        body: params.body,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [DIRECTORIES_KEY] });
      queryClient.invalidateQueries({ queryKey: [FILES_KEY] });
      toast.success("Directory updated");
    },
  });
}

export function useDeleteKnowledgeDirectory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (directoryId: string) => {
      const { data, error } = await deleteKnowledgeDirectory({
        path: { directoryId },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [DIRECTORIES_KEY] });
      queryClient.invalidateQueries({ queryKey: [FILES_KEY] });
      toast.success("Directory deleted. Its files moved to All files.");
    },
  });
}

/**
 * A repository selection mixes documents with the directories holding them,
 * and each is its own resource with its own bulk route. So a mixed selection
 * costs two requests rather than one per row, and their outcomes are merged
 * into the single report the bulk bar shows.
 *
 * A kind with nothing selected is skipped rather than sent as an empty batch,
 * which the routes reject.
 */
async function dispatchByKind(
  items: readonly KnowledgeSelectionItem[],
  run: {
    files: (ids: string[]) => Promise<{
      data?: {
        succeeded: Array<{ name: string }>;
        failed: Array<{ name: string | null; error: string }>;
      };
      error?: unknown;
    }>;
    directories: (ids: string[]) => Promise<{
      data?: {
        succeeded: Array<{ name: string }>;
        failed: Array<{ name: string | null; error: string }>;
      };
      error?: unknown;
    }>;
  },
): Promise<BulkOutcome> {
  const merged: BulkOutcome = { succeeded: [], failed: [] };

  for (const [kind, call] of [
    ["file", run.files],
    ["directory", run.directories],
  ] as const) {
    const ids = items
      .filter((item) => item.kind === kind)
      .map((item) => item.id);
    if (ids.length === 0) continue;

    const { data, error } = await call(ids);
    throwOnApiError(error, { toastOnError: false });
    const outcome = toBulkOutcome(data ?? { succeeded: [], failed: [] });
    merged.succeeded.push(...outcome.succeeded);
    merged.failed.push(...outcome.failed);
  }

  return merged;
}
