import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { incomingEmailKeys } from "@/lib/chatops/incoming-email.query";
import { hookKeys } from "@/lib/hook.query";
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
 *
 * Switching versions serves the previously-read snapshot until the next one
 * arrives, so the reader keeps a preview on screen rather than watching it
 * unmount to a loading line. The cost is that the data and the version that
 * was asked for disagree for as long as the read takes: callers must take the
 * identity off the snapshot they were handed (`data.version`) rather than off
 * their own argument, or they will label one version's config with another's.
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
    placeholderData: keepPreviousData,
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
 * (`baseVersion`), not a client-side re-read. The restore is all-or-nothing —
 * a version referencing something since deleted fails it outright — so every
 * outcome here is either the restored agent or a toast.
 *
 * A handled failure resolves to `null` rather than rejecting, as
 * `useImportGithubSkills` does: the mutation settles as a success carrying no
 * data, so `isError` and `onError` never fire and callers branch on the
 * resolved value. Only a transport failure rejects.
 */
export function useRestoreAgentVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      agentId: string;
      version: number;
      /** Head the preview was rendered against; a moved head 409s the write. */
      baseVersion: number;
    }) => {
      const { data, error } = await restoreAgentVersion({
        path: { id: params.agentId, version: params.version },
        body: { baseVersion: params.baseVersion },
      });
      if (error) {
        if (getApiErrorInternalCode(error) === "agent_version_conflict") {
          toast.error(
            "This configuration changed while you were previewing it. Review the latest version and try again.",
          );
          return null;
        }
        // Every other failure — including the 400 refusing a version that
        // points at something deleted — already carries a readable reason.
        handleApiError(error);
        return null;
      }
      return data ?? null;
    },
    // Reporting success on a suppressed fork would name a version that does
    // not exist, so the copy follows whether the head actually moved.
    onSuccess: (data, variables) => {
      if (!data) return;
      if (data.latestVersion === variables.baseVersion) {
        toast.info(
          `Version ${variables.version} is identical to the current version — nothing to restore.`,
        );
      } else {
        toast.success(
          `Restored version ${variables.version} — created version ${data.latestVersion}`,
        );
      }
    },
    // Every outcome refreshes, not just the write: a rejected compare-and-set
    // means the head moved under the preview.
    //
    // A restore rewrites more than the agent row — its hooks, its tool
    // assignments, and its knowledge links move with it. Only the row and the
    // exclusions live under `["agents"]`; the rest are the keys
    // `useAssignToolsToAgent` invalidates when the editor writes the very same
    // rows, and leaving them is how a restored agent keeps running on its old
    // tool set. The immutable `["agent-version", ...]` snapshots are keyed
    // apart and stay cached.
    onSettled: (_data, _error, variables) => {
      for (const queryKey of [
        // Profile, paginated lists, tool/subagent exclusions, version timeline.
        ["agents"],
        [...hookKeys.list(variables.agentId)],
        // Prefix — also covers `["tools", "unassigned"]`.
        ["tools"],
        ["tools-with-assignments"],
        ["agent-tools"],
        // Assignment counts read off server and catalog cards.
        ["mcp-servers"],
        ["mcp-catalog"],
        ["knowledge-bases"],
        ["connectors"],
        // Prefix — covers the per-agent MCP tool list, which chat holds for
        // five minutes and would otherwise serve from before the restore.
        ["chat", "agents"],
        // A restore rewrites the incoming-email settings too, and the address
        // is derived from them: the ordinary edit path invalidates this exact
        // key for that reason, and the email settings dialog and the A2A
        // connection instructions both read it.
        [...incomingEmailKeys.promptEmailAddress(variables.agentId)],
      ]) {
        queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}
