"use client";

import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useDeleteSkill } from "@/lib/skills/skill.query";
import { useSingleFlight } from "./use-single-flight";

export function DeleteSkillDialog({
  skill,
  open,
  onOpenChange,
  onDeleted,
}: {
  skill: { id: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fires after the delete succeeds, before the dialog closes. */
  onDeleted?: () => void;
}) {
  const deleteSkill = useDeleteSkill();
  // The grant the deleted view of the skills list asks for.
  const { data: canOpenDeletedView } = useHasPermissions(
    { skill: ["update"] },
    "*",
  );
  const handleDelete = useSingleFlight(async () => {
    const result = await deleteSkill.mutateAsync(skill.id);
    if (result) {
      onDeleted?.();
      onOpenChange(false);
    }
  });

  return (
    <DeleteConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete skill"
      description={skillDeleteDescription({
        subject: `"${skill.name}"`,
        count: 1,
        canOpenDeletedView: canOpenDeletedView === true,
      })}
      isPending={deleteSkill.isPending}
      onConfirm={handleDelete}
      confirmLabel="Delete skill"
      pendingLabel="Deleting..."
    />
  );
}

/**
 * What deleting a skill does, for the one-skill and the bulk confirmation.
 *
 * A delete here is not the end of the skill: the row is kept with its
 * instructions, files and versions, and can be restored. So the text says what
 * the reader loses now (the list entry, and agents using it) and how it comes
 * back. The way back differs by reader: the deleted view of the list is open
 * only to someone who manages every skill, so anyone else is pointed to an
 * admin instead of to a filter they do not have.
 */
export function skillDeleteDescription({
  subject,
  count,
  canOpenDeletedView,
}: {
  /** What is being deleted, as it reads after "Delete": a quoted name, "3 skills". */
  subject: string;
  count: number;
  canOpenDeletedView: boolean;
}): string {
  const one = count === 1;
  return [
    `Delete ${subject}?`,
    `${one ? "It leaves" : "They leave"} the skills list and agents can no longer use ${one ? "it" : "them"}.`,
    `${one ? "Its" : "Their"} instructions, files and versions are kept.`,
    canOpenDeletedView
      ? `To restore ${one ? "it" : "them"}, set the status filter of the skills list to Deleted.`
      : `An admin can restore ${one ? "it" : "them"}.`,
  ].join(" ");
}
