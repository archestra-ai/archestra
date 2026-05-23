import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getApiErrorMessage, handleApiError } from "@/lib/utils";

const {
  getSkills,
  getSkill,
  getSkillSourceRepos,
  createSkill,
  updateSkill,
  deleteSkill,
  discoverGithubSkills,
  previewGithubSkill,
  importGithubSkills,
  enableSkillToolDefaults,
} = archestraApiSdk;

type SkillsQuery = NonNullable<archestraApiTypes.GetSkillsData["query"]>;
type SkillsPaginatedParams = Pick<
  SkillsQuery,
  "limit" | "offset" | "search" | "sourceRepo"
>;

// ===== Query hooks =====

export function useSkillsPaginated(
  params: SkillsPaginatedParams,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: ["skills", "paginated", params],
    enabled: options?.enabled ?? true,
    placeholderData: (previousData) => previousData,
    queryFn: async () => {
      const { data, error } = await getSkills({ query: params });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
  });
}

export function useSkillSourceRepos() {
  return useQuery({
    queryKey: ["skills", "source-repos"],
    queryFn: async () => {
      const { data, error } = await getSkillSourceRepos();
      if (error) {
        handleApiError(error);
        return { repos: [] as string[] };
      }
      return data;
    },
  });
}

export function useSkill(id: string | null) {
  return useQuery({
    queryKey: ["skills", id],
    queryFn: async () => {
      const { data, error } = await getSkill({ path: { id: id as string } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    enabled: !!id,
  });
}

// ===== Mutation hooks =====

export function useCreateSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: archestraApiTypes.CreateSkillData["body"]) => {
      const { data, error } = await createSkill({ body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      toast.success("Skill created");
    },
  });
}

export function useUpdateSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      body,
    }: {
      id: string;
      body: archestraApiTypes.UpdateSkillData["body"];
    }) => {
      const { data, error } = await updateSkill({ path: { id }, body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data, variables) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      queryClient.invalidateQueries({ queryKey: ["skills", variables.id] });
      toast.success("Skill updated");
    },
  });
}

export function useDeleteSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await deleteSkill({ path: { id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      toast.success("Skill deleted");
    },
  });
}

export function useDiscoverGithubSkills() {
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.DiscoverGithubSkillsData["body"],
    ) => {
      const { data, error } = await discoverGithubSkills({ body });
      if (error) {
        return { data: null, errorMessage: getApiErrorMessage(error) };
      }
      return { data, errorMessage: null };
    },
  });
}

export function usePreviewGithubSkill(
  body: archestraApiTypes.PreviewGithubSkillData["body"] | null,
) {
  return useQuery({
    queryKey: [
      "skills",
      "github-preview",
      body?.repoUrl,
      body?.path ?? null,
      body?.skillPath,
    ],
    enabled: !!body,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await previewGithubSkill({
        body: body as archestraApiTypes.PreviewGithubSkillData["body"],
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
  });
}

export function useEnableSkillToolDefaults() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await enableSkillToolDefaults();
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      // Backfill has added skill tools to every agent in the org — invalidate
      // all agent/tool caches so the gateway and other agent pages refresh.
      queryClient.invalidateQueries({ queryKey: ["organization"] });
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
      queryClient.invalidateQueries({ queryKey: ["tools"] });
      const { agentsBackfilled } = data;
      toast.success(
        `Skill tools enabled for ${agentsBackfilled} agent${
          agentsBackfilled === 1 ? "" : "s"
        }`,
      );
    },
  });
}

export function useImportGithubSkills() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.ImportGithubSkillsData["body"],
    ) => {
      const { data, error } = await importGithubSkills({ body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      const created = data.created.length;
      const skipped = data.skipped.length;
      toast.success(
        `Imported ${created} skill${created === 1 ? "" : "s"}` +
          (skipped > 0 ? ` — skipped ${skipped} already in the org` : ""),
      );
    },
  });
}
