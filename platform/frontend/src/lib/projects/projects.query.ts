import {
  archestraApiSdk,
  type archestraApiTypes,
  MAX_PROJECT_UPLOAD_BYTES,
  MAX_PROJECT_UPLOAD_MB,
} from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  readFileAsBase64,
  summarizeUploadResults,
  type UploadOutcome,
  validateUploadFile,
} from "@/lib/files/file-upload";
import { handleApiError, throwOnApiError } from "@/lib/utils";

const {
  createProject,
  createProjectFromConversation,
  deleteProject,
  deleteSkillSandboxArtifact,
  getProject,
  getProjectConversations,
  getProjectFiles,
  getProjectInstructions,
  getProjects,
  pinProject,
  setProjectInstructions,
  setProjectShare,
  unpinProject,
  updateProject,
  uploadProjectFiles,
} = archestraApiSdk;

type ProjectListFilters = NonNullable<
  archestraApiTypes.GetProjectsData["query"]
>;

/**
 * Projects list, optionally scoped + searched. The list lives under a
 * `["projects", "list", …]` key so it can be invalidated without touching the
 * per-project detail queries (`["projects", id, …]`). With no filters (the
 * sidebar, and the page's "All" scope) the key is identical, so they share one
 * cache entry.
 */
export function useProjects(
  options?: { enabled?: boolean; toastOnError?: boolean } & ProjectListFilters,
) {
  const scope = options?.scope;
  const search = options?.search?.trim() || undefined;
  const teamIds = options?.teamIds;
  const authorIds = options?.authorIds;
  const excludeAuthorIds = options?.excludeAuthorIds;
  const toastOnError = options?.toastOnError;
  return useQuery({
    queryKey: [
      "projects",
      "list",
      {
        scope: scope ?? null,
        search: search ?? null,
        teamIds: teamIds ?? null,
        authorIds: authorIds ?? null,
        excludeAuthorIds: excludeAuthorIds ?? null,
      },
    ],
    enabled: options?.enabled ?? true,
    queryFn: async () => {
      const { data, error } = await getProjects({
        query: { scope, search, teamIds, authorIds, excludeAuthorIds },
      });
      throwOnApiError(error, { toastOnError });
      return data;
    },
  });
}

export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: ["projects", id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await getProject({
        path: { id: id as string },
      });
      throwOnApiError(error, { allowNotFound: true });
      return data ?? null;
    },
  });
}

export function useProjectConversations(
  id: string | undefined,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: ["projects", id, "conversations"],
    enabled: !!id && (options?.enabled ?? true),
    queryFn: async () => {
      const { data, error } = await getProjectConversations({
        path: { id: id as string },
      });
      throwOnApiError(error, { allowNotFound: true });
      return data ?? null;
    },
  });
}

/** Files belonging to the project; polled like the My Files page. */
export function useProjectFiles(id: string | undefined) {
  return useQuery({
    queryKey: ["projects", id, "files"],
    enabled: !!id,
    refetchInterval: 5000,
    queryFn: async () => {
      const { data, error } = await getProjectFiles({
        path: { id: id as string },
      });
      throwOnApiError(error, { allowNotFound: true });
      return data ?? null;
    },
  });
}

/** The project's instructions ("" when never saved). */
export function useProjectInstructions(id: string | undefined) {
  return useQuery({
    queryKey: ["projects", id, "instructions"],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await getProjectInstructions({
        path: { id: id as string },
      });
      throwOnApiError(error, { allowNotFound: true });
      return data ?? null;
    },
  });
}

export function useSetProjectInstructions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { id: string; content: string }) => {
      const { error } = await setProjectInstructions({
        path: { id: params.id },
        body: { content: params.content },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return true;
    },
    onSuccess: (ok, { id }) => {
      if (!ok) return;
      toast.success("Instructions saved");
      queryClient.invalidateQueries({
        queryKey: ["projects", id, "instructions"],
      });
      // The first save materializes the instructions.md file.
      queryClient.invalidateQueries({ queryKey: ["projects", id, "files"] });
    },
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: NonNullable<archestraApiTypes.CreateProjectData["body"]>,
    ) => {
      const { data, error } = await createProject({ body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (project) => {
      if (!project) return;
      toast.success(`Project "${project.name}" created`);
      queryClient.invalidateQueries({ queryKey: ["projects", "list"] });
    },
  });
}

/**
 * Turn a chat into a project: creates the project, moves the chat into it, and
 * transfers the chat's files. The chat now carries a project tag, so the
 * conversations list is invalidated alongside the projects list.
 */
export function useCreateProjectFromConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: NonNullable<
        archestraApiTypes.CreateProjectFromConversationData["body"]
      >,
    ) => {
      const { data, error } = await createProjectFromConversation({ body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (project) => {
      if (!project) return;
      toast.success(`Project "${project.name}" created from this chat`);
      queryClient.invalidateQueries({ queryKey: ["projects", "list"] });
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

export function useUpdateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      params: { id: string } & NonNullable<
        archestraApiTypes.UpdateProjectData["body"]
      >,
    ) => {
      const { id, ...body } = params;
      const { error } = await updateProject({ path: { id }, body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return true;
    },
    onSuccess: (ok, { id }) => {
      if (!ok) return;
      queryClient.invalidateQueries({ queryKey: ["projects", "list"] });
      queryClient.invalidateQueries({ queryKey: ["projects", id] });
    },
  });
}

/** Pin/unpin a project for the current user (personal — toggle by `pinned`). */
export function usePinProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, pinned }: { id: string; pinned: boolean }) => {
      const { error } = pinned
        ? await pinProject({ path: { id } })
        : await unpinProject({ path: { id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return true;
    },
    onSuccess: (ok, { id }) => {
      if (!ok) return;
      queryClient.invalidateQueries({ queryKey: ["projects", "list"] });
      queryClient.invalidateQueries({ queryKey: ["projects", id] });
    },
  });
}

export function useSetProjectShare() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      id: string;
      visibility: "organization" | "team" | "none";
      teamIds: string[];
    }) => {
      const { error } = await setProjectShare({
        path: { id: params.id },
        body: { visibility: params.visibility, teamIds: params.teamIds },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return true;
    },
    onSuccess: (ok, { id }) => {
      if (!ok) return;
      toast.success("Project sharing updated");
      queryClient.invalidateQueries({ queryKey: ["projects", "list"] });
      queryClient.invalidateQueries({ queryKey: ["projects", id] });
    },
  });
}

export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const { error } = await deleteProject({ path: { id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return true;
    },
    onSuccess: (ok) => {
      if (!ok) return;
      toast.success(
        "Project deleted — its chats were kept as ordinary conversations.",
      );
      // Refresh only the project LIST queries (`["projects", "list", …]`). This
      // can't prefix-match the deleted project's own detail/conversations/files
      // queries (`["projects", id, …]`), which are still mounted for the instant
      // before we navigate away and would 404 on the now-gone id.
      queryClient.invalidateQueries({ queryKey: ["projects", "list"] });
    },
  });
}

/**
 * Delete one or more project files (persisted skill-sandbox artifacts). Runs the
 * deletes concurrently and reports a single summary toast and the ids that
 * failed. Deleting a project file removes it project-wide, so it also refreshes
 * any chat Files panels (`["conversation-files", …]`) that list project files.
 */
export function useDeleteProjectFiles(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (items: Array<{ id: string }>) => {
      const results = await Promise.allSettled(
        items.map((item) =>
          deleteSkillSandboxArtifact({ path: { artifactId: item.id } }),
        ),
      );
      const failedIds = items
        .filter((_, i) => {
          const r = results[i];
          return r.status === "rejected" || r.value.error != null;
        })
        .map((item) => item.id);
      return { total: items.length, failedIds };
    },
    onSuccess: ({ total, failedIds }) => {
      const deleted = total - failedIds.length;
      if (failedIds.length === 0) {
        toast.success(total === 1 ? "File deleted" : `Deleted ${total} files`);
      } else {
        toast.error(
          `Deleted ${deleted} of ${total}; ${failedIds.length} failed`,
        );
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: ["projects", projectId, "files"],
      });
      queryClient.invalidateQueries({ queryKey: ["conversation-files"] });
    },
  });
}

/**
 * Upload dropped files into the project, one request per file, sequentially —
 * so a multi-file drop never aggregates into one oversized body and one file's
 * failure (oversize, server error) never aborts the rest. Over-limit / empty
 * files are caught client-side before any request. A new project file is visible
 * to every chat in the project, so it also refreshes chat Files panels
 * (`["conversation-files", …]`).
 */
export function useUploadProjectFiles(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (files: File[]): Promise<UploadOutcome[]> => {
      const results: UploadOutcome[] = [];
      for (const file of files) {
        const validation = validateUploadFile(file, MAX_PROJECT_UPLOAD_BYTES);
        if (!validation.ok) {
          results.push({
            name: file.name,
            ok: false,
            reason: validation.reason,
          });
          continue;
        }
        try {
          const dataBase64 = await readFileAsBase64(file);
          const { error } = await uploadProjectFiles({
            path: { id: projectId },
            body: { name: file.name, mimeType: file.type, dataBase64 },
          });
          results.push({
            name: file.name,
            ok: error == null,
            reason: error == null ? undefined : "server",
          });
        } catch {
          results.push({ name: file.name, ok: false, reason: "server" });
        }
      }
      return results;
    },
    onSuccess: (results) => {
      for (const { type, message } of summarizeUploadResults(
        results,
        MAX_PROJECT_UPLOAD_MB,
      )) {
        if (type === "success") toast.success(message);
        else toast.error(message);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: ["projects", projectId, "files"],
      });
      queryClient.invalidateQueries({ queryKey: ["conversation-files"] });
    },
  });
}
