"use client";

import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { DeletedItemsHint } from "@/components/deleted-items-hint";
import { ItemNames } from "@/components/item-names";
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
      description={
        <SkillDeleteDescription
          skills={[skill]}
          canOpenDeletedView={canOpenDeletedView === true}
          onNavigate={() => onOpenChange(false)}
        />
      }
      isPending={deleteSkill.isPending}
      onConfirm={handleDelete}
      confirmLabel="Delete skill"
      pendingLabel="Deleting..."
    />
  );
}

/**
 * What deleting skills does, for the one-skill and the bulk confirmation.
 *
 * A delete here is not the end of a skill: it is kept and can be restored. So
 * the text says what is lost now (agents using it) and where it comes back
 * from. The way back differs by reader: the deleted view of the list is open
 * only to someone who manages every skill, so anyone else is pointed to an
 * admin instead of to a filter they do not have.
 *
 * Two rows inside the dialog's description, which is a paragraph itself, so
 * they are spans laid out as blocks.
 */
export function SkillDeleteDescription({
  skills,
  canOpenDeletedView,
  onNavigate,
}: {
  /** The skills about to be deleted, named in the text. */
  skills: ReadonlyArray<{ id: string; name: string }>;
  canOpenDeletedView: boolean;
  /** The Deleted link was followed: the dialog it sits in should close. */
  onNavigate?: () => void;
}) {
  return (
    <>
      {/* The header puts 8px under the title. This adds 8px, so the text
          starts 16px below it: further from the title than its two rows are
          from each other (12px), which keeps the rows reading as one text. */}
      <span className="mt-2 block">
        <span>Agents will no longer be able to use </span>
        <ItemNames items={skills} />
        <span>{skills.length === 1 ? " skill." : " skills."}</span>
      </span>
      <span className="mt-3 block">
        <DeletedItemsHint
          nounPlural="skills"
          listPath="/skills"
          listName="Skills"
          canOpenDeletedView={canOpenDeletedView}
          onNavigate={onNavigate}
        />
      </span>
    </>
  );
}
