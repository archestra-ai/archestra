"use client";

import { ArrowUpCircle } from "lucide-react";
import { useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { PermissionButton } from "@/components/ui/permission-button";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useResetSkill } from "@/lib/skills/skill.query";

/**
 * Shown on an edited built-in skill that missed a newer shipped default. An
 * edited copy is never upgraded automatically, so without this the copy goes
 * stale silently.
 */
export function BuiltInUpdateNotice({
  skillId,
  skillName,
  disabledReason,
}: {
  skillId: string;
  skillName: string;
  /** Why the reset is unavailable right now, such as unsaved edits. */
  disabledReason?: string;
}) {
  const appName = useAppName();
  const resetSkill = useResetSkill();
  const [confirming, setConfirming] = useState(false);

  return (
    <>
      <InlineNotice variant="info">
        <ArrowUpCircle />
        <span className="font-medium">A newer default is available</span>
        <InlineNoticeText>
          This copy was edited, so {appName} stopped updating it. Reset it to
          get the current default. Your edits stay in the version history.
        </InlineNoticeText>
        <PermissionButton
          size="xs"
          variant="outline"
          className="ml-auto"
          permissions={{ skill: ["update"] }}
          permissionScope={skillId}
          disabled={Boolean(disabledReason) || resetSkill.isPending}
          tooltip={disabledReason}
          onClick={() => setConfirming(true)}
        >
          Reset to default
        </PermissionButton>
      </InlineNotice>
      <DeleteConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Reset skill"
        description={`Reset "${skillName}" to the version ${appName} ships? Your edits to its instructions and resource files are replaced, and the shipped content is recorded as a new version.`}
        isPending={resetSkill.isPending}
        onConfirm={async () => {
          const result = await resetSkill.mutateAsync(skillId);
          if (result) setConfirming(false);
        }}
        confirmLabel="Reset to default"
        pendingLabel="Resetting..."
      />
    </>
  );
}
