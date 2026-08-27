import {
  archestraApiSdk,
  type archestraApiTypes,
  MAX_BULK_IDS,
} from "@archestra/shared";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { trackEvent } from "@/lib/analytics";
import { useAllMatching } from "@/lib/hooks/use-all-matching";
import { composeManifest } from "@/lib/skills/manifest-compose";
import {
  getApiErrorInternalCode,
  getApiErrorMessage,
  handleApiError,
  throwOnApiError,
} from "@/lib/utils";

const {
  bulkDeleteSkills,
  bulkUpdateSkillsVisibility,
  getSkills,
  getSkill,
  getExternalMcpSkill,
  getExternalMcpSkills,
  getExternalMcpSkillUsageStatistics,
  getPluginSkill,
  getPluginSkills,
  getPluginSkillUsageStatistics,
  getSkillSourceRepos,
  getSkillUsageStatistics,
  getSkillVersion,
  getSkillVersions,
  createSkill,
  updateSkill,
  updateSkillGithubSync,
  deleteSkill,
  permanentlyDeleteSkill,
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

export type SkillUsageReference =
  | { kind: "standalone"; skillId: string }
  | { kind: "externalMcp"; mcpServerId: string; uri: string }
  | { kind: "plugin"; pluginId: string; skillPath: string };

export const externalMcpSkillsQueryKey = [
  "skills",
  "external-mcp",
  "list",
] as const;
export const externalMcpSkillDetailQueryKey = [
  "skills",
  "external-mcp",
  "detail",
] as const;
export const pluginSkillsQueryKey = ["skills", "plugins", "list"] as const;
export const pluginSkillDetailQueryKey = [
  "skills",
  "plugins",
  "detail",
] as const;

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

/**
 * Every skill matching `params`, not just the page in view — what backs the
 * table's "select all N skills that match this search query".
 *
 * The list route caps a page at 100, so this walks the offsets. It stops at
 * `MAX_BULK_IDS` because that is the largest batch a bulk route accepts:
 * collecting more would only build a selection the action must refuse. Pass
 * `enabled` so the walk happens on escalation rather than on every render of a
 * table nobody has selected anything in.
 */
export function useAllMatchingSkills(
  params: Omit<SkillsPaginatedParams, "limit" | "offset">,
  options?: { enabled?: boolean },
) {
  return useAllMatching({
    queryKey: ["skills", "all-matching", params],
    enabled: options?.enabled,
    // The bulk routes take at most this many ids, so a longer walk could only
    // build a selection they would refuse.
    max: MAX_BULK_IDS,
    fetchPage: async ({ limit, offset }) => {
      const { data, error } = await getSkills({
        query: { ...params, limit, offset },
      });
      throwOnApiError(error);
      return data?.data ?? [];
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

/** Per-user activation counts for one Skill over the last 30 days. */
export function useSkillUsageStatistics(reference: SkillUsageReference | null) {
  return useQuery({
    queryKey: ["skills", "usage-statistics", reference],
    enabled: !!reference,
    queryFn: async () => {
      if (!reference) return null;
      const { data, error } =
        reference.kind === "standalone"
          ? await getSkillUsageStatistics({
              path: { id: reference.skillId },
            })
          : reference.kind === "externalMcp"
            ? await getExternalMcpSkillUsageStatistics({
                query: {
                  mcpServerId: reference.mcpServerId,
                  uri: reference.uri,
                },
              })
            : await getPluginSkillUsageStatistics({
                path: { pluginId: reference.pluginId },
                query: reference.skillPath
                  ? { skillPath: reference.skillPath }
                  : {},
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

export function useExternalMcpSkills(params?: {
  enabled?: boolean;
  environmentId?: string;
}) {
  return useQuery({
    queryKey: [...externalMcpSkillsQueryKey, params?.environmentId ?? null],
    enabled: params?.enabled ?? true,
    staleTime: 0,
    refetchOnMount: "always",
    queryFn: async () => {
      const { data, error } = await getExternalMcpSkills({
        query: params?.environmentId
          ? { environmentId: params.environmentId }
          : {},
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
  });
}

export function useExternalMcpSkill(params: {
  id: string | null;
  mcpServerId: string | null;
}) {
  return useQuery({
    queryKey: [
      ...externalMcpSkillDetailQueryKey,
      params.id,
      params.mcpServerId,
    ],
    enabled: !!params.id && !!params.mcpServerId,
    staleTime: 0,
    refetchOnMount: "always",
    queryFn: async () => {
      const { data, error } = await getExternalMcpSkill({
        path: { id: params.id as string },
        query: { mcpServerId: params.mcpServerId as string },
      });
      throwOnApiError(error, { allowNotFound: true, toastOnError: false });
      return data ?? null;
    },
  });
}

export function usePluginSkills(params?: { enabled?: boolean }) {
  return useQuery({
    queryKey: pluginSkillsQueryKey,
    enabled: params?.enabled ?? true,
    queryFn: async () => {
      const { data, error } = await getPluginSkills();
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
  });
}

export function usePluginSkill(params: {
  pluginId: string | null;
  skillPath: string | null;
}) {
  return useQuery({
    queryKey: [...pluginSkillDetailQueryKey, params.pluginId, params.skillPath],
    enabled: !!params.pluginId && params.skillPath !== null,
    queryFn: async () => {
      const { data, error } = await getPluginSkill({
        path: { pluginId: params.pluginId as string },
        query: params.skillPath ? { skillPath: params.skillPath } : {},
      });
      throwOnApiError(error, { allowNotFound: true, toastOnError: false });
      return data ?? null;
    },
  });
}

/** A skill's version history, newest first, one page at a time. */
export function useSkillVersions(id: string | null) {
  return useInfiniteQuery({
    queryKey: ["skills", id, "versions"],
    enabled: !!id,
    // Deliberately not cached past staleness, unlike `useSkillVersion`. Each row
    // is immutable but the *list* is append-only, and three writers outside this
    // tab extend it: the GitHub sync worker, the MCP skill tools, and other
    // users. Holding a page forever would leave the timeline missing the head
    // that `useSkill` reports on the very next open.
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const { data, error } = await getSkillVersions({
        path: { id: id as string },
        query: { limit: SKILL_VERSIONS_PAGE_SIZE, offset: pageParam },
      });
      // The history dialog renders its own failure state with a retry, so a
      // toast here would say the same thing twice, the second time behind the
      // dialog that already said it.
      throwOnApiError(error, { toastOnError: false });
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
 * null rather than an error, so callers must tell a settled `null` apart from a
 * still-loading query by the query's own status rather than by data truthiness.
 */
export function useSkillVersion(id: string | null, version: number | null) {
  return useQuery({
    // Deliberately outside the `["skills", ...]` prefix. A version's bytes are
    // immutable, so no skill write can invalidate them — but every
    // `invalidateQueries({ queryKey: ["skills"] })` in the app prefix-matches,
    // and there are more of those than this file can police. Keying the
    // snapshots apart makes the `staleTime` below hold unconditionally instead
    // of depending on each call site remembering to exclude them.
    queryKey: ["skill-version", id, version],
    enabled: !!id && version !== null && version > 0,
    // A version's bytes never change, and its snapshots carry every resource
    // file in full (base64 for binaries). Re-fetching one on focus or on an
    // unrelated skill edit would re-download all of that for nothing.
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      const { data, error } = await getSkillVersion({
        path: { id: id as string, version: version as number },
      });
      // Silent for the same reason as the list: every caller of this hook
      // renders the failure itself, either as the preview's retry or as the
      // baseline banner, and both distinguish a failed read from a pruned one.
      throwOnApiError(error, { allowNotFound: true, toastOnError: false });
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
    // As on update: the `{ error }` branch above never sees a rejection, and the
    // editor's `mutateAsync` is caught rather than left to reject, so nothing
    // else would report a create that failed to leave the browser.
    onError: (error) => handleApiError(error),
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
        // A 409 here is either the compare-and-set or a name collision, so the
        // internal code decides — the status alone cannot. The generic handler
        // would show the backend's version numbers, which say nothing to
        // someone who was editing a form.
        if (isSkillVersionConflict(error)) {
          // Pull the head that overtook this edit, so the editor has something
          // current to fall back to; the rejected draft is left on screen for
          // the author to copy from.
          queryClient.invalidateQueries({ queryKey: ["skills", id] });
          toast.error(
            "This skill changed while you were editing it. Discard your changes to load the latest version, then reapply them.",
          );
          return null;
        }
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      toast.success("Skill updated");
    },
    // A rejection never reaches the `{ error }` branch above, so a save that
    // failed to leave the browser would otherwise be silent — and the editor
    // awaits `mutateAsync`, where it would surface as an unhandled rejection.
    onError: (error) => handleApiError(error),
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

/**
 * Move a selection of skills to one visibility scope in a single request.
 *
 * Partial success is normal — the route authorizes each skill on its own, and a
 * skill widening into a namespace where its name is taken is rejected
 * individually — so the toast reports both sides rather than claiming a clean
 * sweep. The caller is told whether anything at all landed, so it can keep a
 * failed selection on screen instead of clearing it.
 */
export function useBulkUpdateSkillsVisibility() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.BulkUpdateSkillsVisibilityData["body"],
    ) => {
      const { data, error } = await bulkUpdateSkillsVisibility({ body });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      reportBulkSkillOutcome(data, {
        verb: "Updated",
        failureVerb: "update",
      });
    },
    onError: (error) => handleApiError(error),
  });
}

/** Soft-delete a selection of skills; see {@link useBulkUpdateSkillsVisibility}. */
export function useBulkDeleteSkills() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (skillIds: string[]) => {
      const { data, error } = await bulkDeleteSkills({ body: { skillIds } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      reportBulkSkillOutcome(data, {
        verb: "Deleted",
        failureVerb: "delete",
      });
    },
    onError: (error) => handleApiError(error),
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
 * Permanently destroy a soft-deleted skill: every version and resource file,
 * plus its grants, environment assignments, usage events, and share links.
 *
 * The refusals surface their own message through the error toast — a 409 while
 * a sandbox still mounts one of its versions, a 403 for a built-in.
 */
export function usePermanentlyDeleteSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await permanentlyDeleteSkill({ path: { id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data, id) => {
      if (!data) return;
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      // Drop the detail, versions and usage-statistics queries for an id that
      // no longer resolves, rather than letting a stale history or edit URL
      // remount them and refetch into a 404.
      queryClient.removeQueries({ queryKey: ["skills", id] });
      toast.success("Skill permanently deleted");
    },
  });
}

/**
 * Restore a skill to an earlier version by forking its payload forward: the
 * restored bytes become a *new* head version, so nothing in the history is
 * rewritten.
 *
 * There is no dedicated restore endpoint; this rides on the regular update
 * route, so the resulting version is recorded as an ordinary edit with no
 * "restored from" provenance. Concurrency is the route's own compare-and-set
 * (`baseVersion`), not a client-side re-read.
 */
export function useRestoreSkillVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      skillId,
      version,
      baseVersion,
    }: {
      skillId: string;
      version: number;
      /** Head the preview was rendered against; a moved head 409s the write. */
      baseVersion: number;
    }) => {
      // The frontmatter is read fresh rather than taken from the preview: it
      // lives in columns, not in the snapshot, and a frontmatter-only edit does
      // not move the head — so `baseVersion` cannot stand in for reading it now.
      const [
        { data: skill, error: skillError },
        { data: snapshot, error: snapshotError },
      ] = await Promise.all([
        getSkill({ path: { id: skillId } }),
        getSkillVersion({ path: { id: skillId, version } }),
      ]);
      const readError = skillError ?? snapshotError;
      if (readError) {
        handleApiError(readError);
        return null;
      }
      if (!skill || !snapshot) return null;

      const { data, error } = await updateSkill({
        path: { id: skillId },
        body: {
          // A version snapshots the body alone — frontmatter lives in columns
          // and is not versioned — while the API writes a whole SKILL.md. So
          // the old body is republished under the skill's current frontmatter,
          // which is exactly the edit the snapshot describes.
          content: composeManifest({ ...skill, content: snapshot.content }),
          // Always sent, even when empty: omitting `files` leaves the skill's
          // current resource files untouched, which would pair an old body
          // with newer files. `kind` is re-derived from the path server-side.
          files: snapshot.files.map((file) => ({
            path: file.path,
            content: file.content,
            encoding: file.encoding,
          })),
          baseVersion,
        },
      });
      if (error) {
        if (isSkillVersionConflict(error)) {
          toast.error(
            "This skill changed while you were previewing it. Review the latest version and try again.",
          );
          return null;
        }
        handleApiError(error);
        return null;
      }
      // The backend suppresses a fork whose payload hashes equal to the head, so
      // an unmoved `latestVersion` means the chosen version was already the
      // current one and nothing was written. That still settles the request, so
      // it resolves with the skill — only `null` means "ask again".
      if (data && data.latestVersion === baseVersion) {
        toast.info(
          `Version ${version} is identical to the current version — nothing to restore.`,
        );
      }
      return data;
    },
    // Reporting success on a suppressed fork would name a version that does not
    // exist, so the toast follows the head actually moving.
    onSuccess: (data, variables) => {
      if (!data || data.latestVersion === variables.baseVersion) return;
      toast.success(
        `Restored version ${variables.version} — created version ${data.latestVersion}`,
      );
    },
    // The paths above report on an `{ error }` response. A *rejection* is a
    // different failure — the request never reached the API — and reaches none
    // of them, so without this an offline restore says nothing at all and the
    // confirmation just sits there. Covers both reads and the write.
    onError: (error) => handleApiError(error),
    // Every outcome refreshes, not just the write: a rejected compare-and-set
    // means the head moved under the preview, and a suppressed fork still
    // touched the skill row.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
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

// ===== Internal =====

/**
 * Report a bulk outcome as one toast rather than one per skill.
 *
 * The failure side names the skills it can, because "3 skills could not be
 * updated" leaves the reader to work out which of their selection is still
 * where it was. Only the first few are named — a selection can be a whole page
 * long, and a toast is not a report.
 */
function reportBulkSkillOutcome(
  outcome: {
    succeeded: Array<{ id: string; name: string }>;
    failed: Array<{ id: string; name: string | null; error: string }>;
  },
  labels: { verb: string; failureVerb: string },
) {
  const { succeeded, failed } = outcome;
  const skillCount = (count: number) =>
    `${count} ${count === 1 ? "skill" : "skills"}`;

  if (failed.length === 0) {
    toast.success(`${labels.verb} ${skillCount(succeeded.length)}`);
    return;
  }

  const named = failed
    .slice(0, BULK_FAILURE_NAMES_SHOWN)
    .map((entry) => entry.name ?? entry.id)
    .join(", ");
  const remaining = failed.length - BULK_FAILURE_NAMES_SHOWN;
  const description = remaining > 0 ? `${named} and ${remaining} more` : named;

  if (succeeded.length === 0) {
    toast.error(
      `Could not ${labels.failureVerb} ${skillCount(failed.length)}`,
      {
        // The reason is the same for every entry in the common cases (no
        // permission, name taken), so the first one stands for the rest.
        description: `${description} — ${failed[0].error}`,
      },
    );
    return;
  }

  toast.warning(
    `${labels.verb} ${skillCount(succeeded.length)} — ${skillCount(failed.length)} could not be ${labels.failureVerb}d`,
    { description: `${description} — ${failed[0].error}` },
  );
}

/** How many failed skills a bulk toast names before it starts counting. */
const BULK_FAILURE_NAMES_SHOWN = 3;

/**
 * The update route's compare-and-set rejected the write: the skill moved past
 * the head the edit was composed from.
 *
 * Read off the internal code rather than the 409, which the route also uses for
 * a name collision. The backend's message names version numbers, so every
 * caller replaces it with copy about the read *it* made.
 */
function isSkillVersionConflict(error: unknown): boolean {
  return getApiErrorInternalCode(error) === "skill_version_conflict";
}
