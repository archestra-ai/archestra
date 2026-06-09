import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { handleApiError } from "@/lib/utils";

const { getProjects, getProject, createProject, updateProject, deleteProject } =
  archestraApiSdk;

type ProjectsQuery = NonNullable<archestraApiTypes.GetProjectsData["query"]>;
type UseProjectsParams = Partial<ProjectsQuery> & {
  enabled?: boolean;
};
export type Project =
  archestraApiTypes.GetProjectsResponses["200"]["data"][number];
export type ProjectDetail = archestraApiTypes.GetProjectResponses["200"];

export function useProjects(params: UseProjectsParams = {}) {
  const { enabled = true, ...query } = params;
  return useQuery({
    queryKey: ["projects", query],
    queryFn: async () => {
      const { data, error } = await getProjects({
        query: {
          limit: query.limit ?? 50,
          offset: query.offset ?? 0,
          search: query.search,
          scope: query.scope,
        },
      });
      if (error) {
        handleApiError(error);
        return {
          data: [] as Project[],
          pagination: {
            currentPage: 1,
            limit: query.limit ?? 50,
            total: 0,
            totalPages: 0,
            hasNext: false,
            hasPrev: false,
          },
        };
      }
      return data;
    },
    enabled,
  });
}

export function useProject(id?: string) {
  return useQuery({
    queryKey: ["project", id],
    queryFn: async () => {
      if (!id) return null;
      const { data, error } = await getProject({ path: { id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    enabled: !!id,
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: archestraApiTypes.CreateProjectData["body"]) => {
      const { data, error } = await createProject({ body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (project) => {
      if (!project) return;
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.setQueryData(["project", project.id], project);
    },
  });
}

export function useUpdateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...body
    }: { id: string } & archestraApiTypes.UpdateProjectData["body"]) => {
      const { data, error } = await updateProject({
        path: { id },
        body,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (project) => {
      if (!project) return;
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.setQueryData(["project", project.id], project);
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await deleteProject({ path: { id } });
      if (error) {
        handleApiError(error);
        return false;
      }
      return true;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}
