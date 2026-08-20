"use client";

import type { AgentType } from "@archestra/shared";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import {
  computeMcpEnvConflicts,
  summarizeBulkFailure,
} from "@/components/agent-tools-editor.utils";
import {
  useAgentTools,
  useBulkUpdateAgentTools,
} from "@/lib/agent-tools.query";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import { shouldOfferAppCatalogs } from "./agent-form.utils";

/** One MCP catalog the agent uses that does not belong to the new environment. */
export type AgentEnvironmentConflict = { catalogId: string; name: string };

export interface AgentEnvironmentConflictsState {
  /** Whether the check is running at all (an edit that actually moves the agent). */
  enabled: boolean;
  /** Catalogs the agent has tools from that the new environment cannot reach. */
  conflicts: AgentEnvironmentConflict[];
  /** The assigned tool ids {@link removeConflictingTools} would unassign. */
  conflictingToolIds: string[];
  /** Neither input has arrived yet, so the answer is not known. */
  isVerifying: boolean;
  /** An input failed, so the answer cannot be known. */
  isUnverifiable: boolean;
  /** A removal is in flight. */
  isRemoving: boolean;
  /** Fail-closed: true whenever the environment change must not be saved. */
  blocksSave: boolean;
  /**
   * Unassign every conflicting tool, then re-read the assignments and judge
   * them again. Resolves `true` only when that fresh read shows no conflict
   * left; every other outcome — a rejected write, a rejection reported inside
   * a 200, an unreadable re-read, a conflict that survived — resolves `false`,
   * and the caller must not go on to save the environment.
   */
  removeConflictingTools: () => Promise<boolean>;
}

/**
 * Whether moving an agent to another environment would strand tools it already
 * has, for the wizard step that shows the environment without the tools editor.
 *
 * The tools editor answers this itself while it is mounted; on the
 * Configuration step it is not, and the form used to settle for a warning that
 * a user could save straight past. This computes the same verdict from the
 * agent's *saved* assignments, and — because a wrong "no conflicts" is the
 * expensive answer — reports a pending or failed read as still blocking rather
 * than as a clean bill of health.
 */
export function useAgentEnvironmentConflicts(params: {
  agentId: string | undefined;
  /** The environment the form is about to save, not the stored one. */
  environmentId: string | null;
  agentType: AgentType;
  enabled: boolean;
}): AgentEnvironmentConflictsState {
  const { agentId, environmentId, agentType } = params;
  const enabled = params.enabled && !!agentId;

  // Built exactly as the tools editor builds it, so both read the same rows:
  // an app backing missing here would look like a catalog that cannot conflict.
  const catalog = useInternalMcpCatalog({
    includeApps: shouldOfferAppCatalogs(agentType),
    enabled,
  });
  const assignedTools = useAgentTools(agentId, { enabled });
  const bulkUpdateTools = useBulkUpdateAgentTools();

  const assignedToolIdsByCatalog = useMemo(() => {
    const byCatalog = new Map<string, string[]>();
    for (const tool of assignedTools.data ?? []) {
      if (!tool.catalogId) continue;
      const ids = byCatalog.get(tool.catalogId);
      if (ids) ids.push(tool.id);
      else byCatalog.set(tool.catalogId, [tool.id]);
    }
    return byCatalog;
  }, [assignedTools.data]);

  const conflicts = useMemo(
    () =>
      enabled
        ? computeMcpEnvConflicts(
            catalog.data ?? [],
            assignedToolIdsByCatalog.keys(),
            environmentId,
          )
        : [],
    [enabled, catalog.data, assignedToolIdsByCatalog, environmentId],
  );

  const conflictingToolIds = useMemo(
    () =>
      conflicts.flatMap(
        ({ catalogId }) => assignedToolIdsByCatalog.get(catalogId) ?? [],
      ),
    [conflicts, assignedToolIdsByCatalog],
  );

  const { refetch: refetchAssignedTools } = assignedTools;
  const catalogItems = catalog.data;
  const removeConflictingTools = useCallback(async () => {
    if (!agentId || conflictingToolIds.length === 0) return false;
    let removal: Awaited<ReturnType<typeof bulkUpdateTools.mutateAsync>>;
    try {
      removal = await bulkUpdateTools.mutateAsync({
        removals: conflictingToolIds.map((toolId) => ({ agentId, toolId })),
      });
    } catch {
      // The mutation already surfaced the API error; the caller only needs to
      // know that nothing was removed, so the environment stays unsaved.
      return false;
    }
    // The endpoint answers 200 and names what it refused in `failed` — the
    // only part of the response that reports one, which is how the tools
    // editor reads it too. Nothing else has said this out loud.
    const refused = summarizeBulkFailure(removal?.failed);
    if (refused) {
      toast.error(refused);
      return false;
    }
    // The verdict above was computed from the assignments read, so the answer
    // has to be recomputed from a fresh one: a removal the API called clean is
    // still not a clean environment until the assignments say so.
    const reread = await refetchAssignedTools();
    if (reread.isError || !reread.data || !catalogItems) {
      toast.error(
        "The tools were unassigned, but the result could not be re-read. Try again.",
      );
      return false;
    }
    const remaining = computeMcpEnvConflicts(
      catalogItems,
      new Set(
        reread.data.flatMap((tool) => (tool.catalogId ? [tool.catalogId] : [])),
      ),
      environmentId,
    );
    if (remaining.length > 0) {
      toast.error(
        "Some tools that the new environment cannot reach are still assigned.",
      );
      return false;
    }
    return true;
  }, [
    agentId,
    conflictingToolIds,
    bulkUpdateTools,
    refetchAssignedTools,
    catalogItems,
    environmentId,
  ]);

  const isVerifying = enabled && (catalog.isPending || assignedTools.isPending);
  const isUnverifiable = enabled && (catalog.isError || assignedTools.isError);

  return {
    enabled,
    conflicts,
    conflictingToolIds,
    isVerifying,
    isUnverifiable,
    isRemoving: bulkUpdateTools.isPending,
    blocksSave:
      enabled && (isVerifying || isUnverifiable || conflicts.length > 0),
    removeConflictingTools,
  };
}
