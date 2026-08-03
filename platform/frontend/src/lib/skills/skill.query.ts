import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { trackEvent } from "@/lib/analytics";
import { composeManifest } from "@/lib/skills/manifest-compose";
import {
  getApiErrorMessage,
  handleApiError,
  throwOnApiError,
} from "@/lib/utils";

const {
  getSkills,
  getSkill,
  getSkillSourceRepos,
  getSkillUsageStatistics,
  getSkillVersion,
  getSkillVersions,
  createSkill,
  updateSkill,
  updateSkillGithubSync,
  deleteSkill,
  restoreSkill,
  resetSkill,
  discoverGithubSkills,
  searchSkillCatalog,
  previewGithubSkill,
  importGithubSkills,
} = archestraApiSdk;

export type SkillCatalogResult =
  archestraApiTypes.SearchSkillCatalogResponses["200"]["results"][number];

/** One row of a skill's version history (no SKILL.md body). */
export type SkillVersionSummary =
  archestraApiTypes.GetSkillVersionsResponses["200"]["data"][number];

/** One immutable version with its SKILL.md body and resource files. */
export type SkillVersionDetail =
  archestraApiTypes.GetSkillVersionResponses["200"];

const SKILL_VERSIONS_PAGE_SIZE = 20;

type SkillsQuery = NonNullable<archestraApiTypes.GetSkillsData["query"]>;
type SkillsPaginatedParams = Pick<
  SkillsQuery,
  | "limit"
  | "offset"
  | "search"
  | "sourceRepo"
  | "forAgentId"
  | "scope"
  | "teamIds"
  | "authorIds"
  | "excludeAuthorIds"
  | "excludeOtherPersonalSkills"
  | "status"
  | "sortBy"
  | "sortDirection"
>;

// ===== Query hooks =====

export function useSkillsPaginated(
  params: SkillsPaginatedParams,
  options?: { enabled?: boolean; toastOnError?: boolean },
) {
  const toastOnError = options?.toastOnError;
  return useQuery({
    queryKey: ["skills", "paginated", params],
    enabled: options?.enabled ?? true,
    placeholderData: (previousData) => previousData,
    queryFn: async () => {
      const { data, error } = await getSkills({ query: params });
      throwOnApiError(error, { toastOnError });
      return data;
    },
  });
}

export function useSkillSourceRepos() {
  return useQuery({
    queryKey: ["skills", "source-repos"],
    queryFn: async () => {
      const { data, error } = await getSkillSourceRepos();
      throwOnApiError(error);
      return data;
    },
  });
}

// searches the crawled public-GitHub skill catalog on the backend. `search` is
// already debounced by the SearchInput, so keying the query on it is enough;
// placeholderData keeps the previous results visible while the next query runs.
export function useSearchSkillCatalog(search: string) {
  const query = search.trim();
  return useQuery({
    queryKey: ["skills", "catalog-search", query],
    enabled: query.length > 0,
    placeholderData: (previousData) => previousData,
    queryFn: async () => {
      const { data, error } = await searchSkillCatalog({ query: { q: query } });
      if (error) {
        // re-throw so the query enters its error state and the page renders
        // its "could not search" branch, rather than an empty-results state.
        handleApiError(error);
        throw new Error(getApiErrorMessage(error));
      }
      return data;
    },
  });
}

/** Per-user activation counts for one skill over the last 30 days. */
export function useSkillUsageStatistics(id: string | null) {
  return useQuery({
    queryKey: ["skills", id, "usage-statistics"],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await getSkillUsageStatistics({
        path: { id: id as string },
      });
      throwOnApiError(error, { allowNotFound: true });
      return data ?? null;
    },
  });
}

export function useSkill(id: string | null) {
  return useQuery({
    queryKey: ["skills", id],
    queryFn: async () => {
      const { data, error } = await getSkill({ path: { id: id as string } });
      throwOnApiError(error, { allowNotFound: true });
      return data ?? null;
    },
    enabled: !!id,
  });
}

/** A skill's version history, newest first, one page at a time. */
export function useSkillVersions(id: string | null) {
  return useInfiniteQuery({
    queryKey: ["skills", id, "versions"],
    enabled: !!id,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const { data, error } = await getSkillVersions({
        path: { id: id as string },
        query: { limit: SKILL_VERSIONS_PAGE_SIZE, offset: pageParam },
      });
      throwOnApiError(error);
      return data;
    },
    getNextPageParam: (lastPage, allPages) =>
      lastPage?.pagination.hasNext
        ? allPages.reduce(
            (loaded, page) => loaded + (page?.data.length ?? 0),
            0,
          )
        : undefined,
  });
}

/**
 * One version's SKILL.md body and resource files. A missing version resolves to
 * null rather than an error: the diff view asks for the predecessor of the
 * oldest loaded row, which legitimately may not exist.
 */
export function useSkillVersion(id: string | null, version: number | null) {
  return useQuery({
    queryKey: ["skills", id, "version", version],
    enabled: !!id && version !== null && version > 0,
    queryFn: async () => {
      const { data, error } = await getSkillVersion({
        path: { id: id as string, version: version as number },
      });
      throwOnApiError(error, { allowNotFound: true });
      return data ?? null;
    },
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
      trackEvent("skill_created", { skillId: data.id });
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

export function useRestoreSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await restoreSkill({ path: { id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      toast.success("Skill restored");
    },
  });
}

/**
 * Restore a skill to an earlier version by forking its payload forward: the
 * restored bytes become a *new* head version, so nothing in the history is
 * rewritten.
 *
 * Until a dedicated restore endpoint exists this rides on the regular update
 * route, which means the concurrency guard is a client-side re-read rather than
 * a server-side check, and the resulting version is recorded as an ordinary
 * edit (no "restored from" provenance).
 */
export function useRestoreSkillVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      skillId,
      version,
      expectedHeadVersion,
      headContentHash,
    }: {
      skillId: string;
      version: number;
      /** Head the preview was rendered against; a moved head aborts the write. */
      expectedHeadVersion: number;
      /** Content hash of that head, used to detect a restore that changes nothing. */
      headContentHash: string;
    }) => {
      // Re-read the head at submit time: the previewed history may be minutes
      // old, and restoring over someone else's newer edit would bury it.
      const { data: current, error: currentError } = await getSkill({
        path: { id: skillId },
      });
      if (currentError) {
        handleApiError(currentError);
        return null;
      }
      if (!current) return null;
      if (current.latestVersion !== expectedHeadVersion) {
        toast.error(
          "This skill changed while you were previewing it. Review the latest version and try again.",
        );
        return null;
      }

      const { data: snapshot, error: snapshotError } = await getSkillVersion({
        path: { id: skillId, version },
      });
      if (snapshotError) {
        handleApiError(snapshotError);
        return null;
      }
      if (!snapshot) return null;

      // Identical content does not fork a version (the backend suppresses no-op
      // forks by content hash), so reporting a restore would name a version
      // that was never created.
      if (snapshot.contentHash === headContentHash) {
        toast.info(
          `Version ${version} is identical to the current version — nothing to restore.`,
        );
        return null;
      }

      const { data, error } = await updateSkill({
        path: { id: skillId },
        body: {
          // A version snapshots the body alone — frontmatter lives in columns
          // and is not versioned — while the API writes a whole SKILL.md. So
          // the old body is republished under the skill's current frontmatter,
          // which is exactly the edit the snapshot describes.
          content: composeManifest({ ...current, content: snapshot.content }),
          // Always sent, even when empty: omitting `files` leaves the skill's
          // current resource files untouched, which would pair an old body
          // with newer files. `kind` is re-derived from the path server-side.
          files: snapshot.files.map((file) => ({
            path: file.path,
            content: file.content,
            encoding: file.encoding,
          })),
        },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data, variables) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      toast.success(
        `Restored version ${variables.version} — created version ${data.latestVersion}`,
      );
    },
  });
}

export function useResetSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await resetSkill({ path: { id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      queryClient.invalidateQueries({ queryKey: ["skills", data.id] });
      toast.success("Skill reset to default");
    },
  });
}

/**
 * Manage a GitHub-synced skill: change its pull frequency, trigger an
 * immediate pull (`syncNow`), or disconnect it (`interval: null`).
 */
export function useUpdateSkillGithubSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      body,
    }: {
      id: string;
      body: archestraApiTypes.UpdateSkillGithubSyncData["body"];
    }) => {
      const { data, error } = await updateSkillGithubSync({
        path: { id },
        body,
      });
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
      if (variables.body.syncNow) {
        toast.success("Sync started — the skill updates in the background");
      } else if (variables.body.disconnect) {
        toast.success("Sync stopped — the skill is now editable");
      } else {
        toast.success("Sync frequency updated");
      }
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
      throwOnApiError(error);
      return data;
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
      const droppedFiles = data.skippedFiles.reduce(
        (sum, entry) => sum + entry.files.length,
        0,
      );
      if (droppedFiles > 0) {
        toast.warning(
          `${droppedFiles} resource file${droppedFiles === 1 ? " was" : "s were"} not imported (oversized or unfetchable)`,
        );
      }
    },
  });
}
