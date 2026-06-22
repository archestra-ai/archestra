import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getApiErrorType, handleApiError } from "@/lib/utils";

/**
 * A project the user is viewing can vanish — deleted in this tab, or by someone
 * else who shared it. The detail page already renders that gracefully ("Project
 * not found."), so a not-found is an expected empty state, not an error worth a
 * toast + Sentry capture. Other failures still surface normally.
 */
function isProjectNotFound(error: unknown): boolean {
  return getApiErrorType(error) === "api_not_found_error";
}

const {
  createProject,
  deleteProject,
  getProject,
  getProjectConversations,
  getProjectFiles,
  getProjects,
  setProjectShare,
  updateProject,
} = archestraApiSdk;

export function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: async () => {
      const { data, error } = await getProjects();
      if (error) {
        handleApiError(error);
        return null;
      }
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
      if (error) {
        if (!isProjectNotFound(error)) handleApiError(error);
        return null;
      }
      return data;
    },
  });
}

export function useProjectConversations(id: string | undefined) {
  return useQuery({
    queryKey: ["projects", id, "conversations"],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await getProjectConversations({
        path: { id: id as string },
      });
      if (error) {
        if (!isProjectNotFound(error)) handleApiError(error);
        return null;
      }
      return data;
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
      if (error) {
        if (!isProjectNotFound(error)) handleApiError(error);
        return null;
      }
      return data;
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
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      // its files appear on the My Files page too
      queryClient.invalidateQueries({ queryKey: ["sandbox-files"] });
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
      queryClient.invalidateQueries({ queryKey: ["projects"] });
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
      queryClient.invalidateQueries({ queryKey: ["projects"] });
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
      // Refresh only the project LIST. `exact` keeps this from prefix-matching
      // — and thus refetching — the deleted project's own detail/conversations/
      // files queries, which are still mounted for the instant before we
      // navigate away and would 404 on the now-gone id.
      queryClient.invalidateQueries({ queryKey: ["projects"], exact: true });
    },
  });
}
