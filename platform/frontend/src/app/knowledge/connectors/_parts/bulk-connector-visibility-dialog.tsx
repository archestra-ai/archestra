"use client";

import { useState } from "react";
import { KnowledgeSourceVisibilitySelector } from "@/app/knowledge/_parts/knowledge-source-visibility-selector";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { DialogStickyFooter } from "@/components/ui/dialog";

/** The visibility a connector can be moved to in a batch. */
export type BulkConnectorVisibility = "org-wide" | "team-scoped";

/**
 * Set one audience across a selection of connectors.
 *
 * `auto-sync-permissions` is deliberately absent, matching what the bulk route
 * accepts: switching a connector to it fail-closes its whole corpus until a
 * permission pass completes, and whether it is even possible depends on the
 * connector's own type — so it stays a per-connector decision made in the
 * connector's own edit dialog.
 *
 * Mount it only while it is open: the selector holds transient team state that
 * has to start fresh for each new selection.
 */
export function BulkConnectorVisibilityDialog({
  count,
  open,
  onOpenChange,
  onApply,
  isPending,
}: {
  count: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Resolves to whether anything actually moved. A batch where nothing landed
   * keeps the dialog open with the selection intact, so the choice can be
   * corrected rather than rebuilt.
   */
  onApply: (change: {
    visibility: BulkConnectorVisibility;
    teamIds: string[];
  }) => Promise<boolean>;
  isPending: boolean;
}) {
  const [visibility, setVisibility] =
    useState<BulkConnectorVisibility>("org-wide");
  const [teamIds, setTeamIds] = useState<string[]>([]);

  // The backend refuses a team-scoped connector with no teams; refuse it here
  // too rather than sending a request that can only come back as an error.
  const canApply = visibility !== "team-scoped" || teamIds.length > 0;

  const handleApply = async () => {
    const moved = await onApply({
      visibility,
      teamIds: visibility === "team-scoped" ? teamIds : [],
    });
    if (moved) onOpenChange(false);
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit visibility"
      description={`Applies to ${count} ${
        count === 1 ? "connector" : "connectors"
      }, replacing who can see each of them.`}
      size="medium"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <KnowledgeSourceVisibilitySelector
          visibility={visibility}
          onVisibilityChange={(next) =>
            setVisibility(next as BulkConnectorVisibility)
          }
          teamIds={teamIds}
          onTeamIdsChange={setTeamIds}
          showTeamRequired
          supportsAutoSync={false}
          autoSyncPermissionAction="update"
        />
      </div>

      <DialogStickyFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          <span>Cancel</span>
        </Button>
        <Button disabled={!canApply || isPending} onClick={handleApply}>
          <span>{isPending ? "Applying…" : "Apply"}</span>
        </Button>
      </DialogStickyFooter>
    </FormDialog>
  );
}
