"use client";

import { useCallback } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { useDeleteSkill } from "@/lib/skills/skill.query";

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
  const handleDelete = useCallback(async () => {
    const result = await deleteSkill.mutateAsync(skill.id);
    if (result) {
      onDeleted?.();
      onOpenChange(false);
    }
  }, [skill.id, deleteSkill, onOpenChange, onDeleted]);

  return (
    <DeleteConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete Skill"
      description={`Delete the skill "${skill.name}"? This removes its instructions and resource files. This action cannot be undone.`}
      isPending={deleteSkill.isPending}
      onConfirm={handleDelete}
      confirmLabel="Delete Skill"
      pendingLabel="Deleting..."
    />
  );
}
