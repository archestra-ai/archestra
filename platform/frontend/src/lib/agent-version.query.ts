import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getApiErrorInternalCode,
  handleApiError,
  throwOnApiError,
} from "@/lib/utils";

const { getAgentVersion, getAgentVersions, restoreAgentVersion } =
  archestraApiSdk;

/** One row of an agent's version history (no config snapshot). */
export type AgentVersionSummary =
  archestraApiTypes.GetAgentVersionsResponses["200"]["data"][number];

/** One immutable agent config version, full snapshot included. */
export type AgentVersionDetail =
  archestraApiTypes.GetAgentVersionResponses["200"];

/** The canonical config payload a version captures. */
export type AgentConfigSnapshot = AgentVersionDetail["snapshot"];

const AGENT_VERSIONS_PAGE_SIZE = 20;

/**
 * An agent's version history, newest first, as metadata only. Deliberately not
 * cached past staleness, unlike `useAgentVersion`: each row is immutable but
 * the *list* is append-only — every config-mutating operation, from any user,
 * extends it — so holding a page forever would leave the timeline missing the
 * head that `useProfile` reports on the very next open.
 */
export function useAgentVersions(id: string | null) {
  return useInfiniteQuery({
    queryKey: ["agents", id, "versions"],
    enabled: !!id,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const { data, error } = await getAgentVersions({
        path: { id: id as string },
        query: { limit: AGENT_VERSIONS_PAGE_SIZE, offset: pageParam },
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
 * One version's full config snapshot. A missing version resolves to null
 * rather than an error — retention keeps only the last 100 versions, so a
 * pruned one 404s — and callers must tell a settled `null` apart from a
 * still-loading query by the query's own status rather than by data
 * truthiness.
 */
export function useAgentVersion(id: string | null, version: number | null) {
  return useQuery({
    // Deliberately outside the `["agents", ...]` prefix. A version's snapshot
    // is immutable, so no agent write can invalidate it — but broad
    // `invalidateQueries` calls prefix-match, and keying the snapshots apart
    // makes the `staleTime` below hold unconditionally instead of depending on
    // each call site remembering to exclude them.
    queryKey: ["agent-version", id, version],
    enabled: !!id && version !== null && version > 0,
    // A version's snapshot never changes; re-fetching it on focus or on an
    // unrelated agent edit would re-download the full config for nothing.
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      const { data, error } = await getAgentVersion({
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

/**
 * Restore an agent to an earlier version by replaying its snapshot forward:
 * the restored config becomes a *new* head version, so nothing in the history
 * is rewritten. Concurrency is the endpoint's own compare-and-set
 * (`expectedHeadVersion`), not a client-side re-read. Snapshot references the
 * backend could not resolve anymore come back as warnings, not failures.
 */
export function useRestoreAgentVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      agentId: string;
      version: number;
      /** Head the preview was rendered against; a moved head 409s the write. */
      expectedHeadVersion: number;
    }) => {
      const { data, error } = await restoreAgentVersion({
        path: { id: params.agentId, version: params.version },
        body: { expectedHeadVersion: params.expectedHeadVersion },
      });
      if (error) {
        if (getApiErrorInternalCode(error) === "agent_version_conflict") {
          toast.error(
            "This configuration changed while you were previewing it. Review the latest version and try again.",
          );
          return null;
        }
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    // Reporting success on a suppressed fork would name a version that does
    // not exist, so the copy follows whether the head actually moved.
    onSuccess: (data, variables) => {
      if (!data) return;
      if (data.agent.latestVersion === variables.expectedHeadVersion) {
        toast.info(
          `Version ${variables.version} is identical to the current version — nothing to restore.`,
        );
      } else {
        toast.success(
          `Restored version ${variables.version} — created version ${data.agent.latestVersion}`,
        );
      }
      for (const warning of data.warnings.slice(0, 3)) {
        toast.warning(warning.message);
      }
      if (data.warnings.length > 3) {
        toast.warning(
          `${data.warnings.length - 3} more items could not be restored.`,
        );
      }
    },
    // Every outcome refreshes, not just the write: a rejected compare-and-set
    // means the head moved under the preview. The `["agents"]` prefix covers
    // the profile, the lists, and the version timeline; the immutable
    // `["agent-version", ...]` snapshots are keyed apart and stay cached.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });
}
