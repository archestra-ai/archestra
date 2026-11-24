"use client";

import { QueryLoadError } from "@/components/query-load-error";
import { StandardDialog } from "@/components/standard-dialog";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { useBatterySource } from "@/lib/openappa-batteries.query";
import { PolicyPaneEditor, PolicyPaneSkeleton } from "./policy-source-pane";

/**
 * The source of a battery the policy does not include yet, in the editor the
 * Policy page shows an included battery in: the policy text an include adds.
 */
export function BatterySourceDialog({
  name,
  onClose,
}: {
  name: string;
  onClose: () => void;
}) {
  const source = useBatterySource(name);
  return (
    <StandardDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="large"
      title={`${name} source`}
      description="The policy gets this text when it includes the battery."
      // The editor fills the dialog and scrolls its own text.
      bodyClassName="flex flex-col overflow-hidden p-0"
      footer={<DialogCancelButton>Close</DialogCancelButton>}
    >
      {source.isPending ? (
        <PolicyPaneSkeleton className="min-h-0 flex-1" />
      ) : source.isError || !source.data ? (
        <div className="min-h-0 flex-1 p-3">
          <QueryLoadError
            title="Could not load the battery's source"
            error={source.error}
            onRetry={() => source.refetch()}
          />
        </div>
      ) : (
        <PolicyPaneEditor
          path={`battery-preview/${name}.toml`}
          content={source.data.content}
          ariaLabel={`${name} battery policy TOML`}
          className="min-h-0 flex-1"
        />
      )}
    </StandardDialog>
  );
}
