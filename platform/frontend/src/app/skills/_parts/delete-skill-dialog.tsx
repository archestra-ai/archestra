"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
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
      description={
        <SkillDeleteDescription
          count={1}
          canOpenDeletedView={canOpenDeletedView === true}
          onOpenDeletedView={() => onOpenChange(false)}
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
  count,
  canOpenDeletedView,
  onOpenDeletedView,
}: {
  count: number;
  canOpenDeletedView: boolean;
  /** The link was followed: the dialog it sits in should close. */
  onOpenDeletedView?: () => void;
}) {
  const deletedView = useDeletedSkillsView();
  return (
    <>
      <span className="block">
        Agents will no longer be able to use {count === 1 ? "it" : "them"}.
      </span>
      <span className="mt-3 block">
        {canOpenDeletedView ? (
          <>
            <span>You can restore deleted skills from the </span>
            <Link
              href={deletedView.href}
              onClick={onOpenDeletedView}
              className="font-medium text-foreground underline underline-offset-4 hover:text-primary"
            >
              Deleted
            </Link>
            <span>
              {deletedView.isThisPage
                ? " filter on this page."
                : " filter on the Skills page."}
            </span>
          </>
        ) : (
          <span>An admin can restore deleted skills.</span>
        )}
      </span>
    </>
  );
}

/**
 * Where the deleted skills are listed. From the skills list it is the list as
 * it stands, every filter and the page kept, with the Deleted status added;
 * from anywhere else it is the list with only that status.
 */
function useDeletedSkillsView(): { href: string; isThisPage: boolean } {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isThisPage = pathname === SKILLS_LIST_PATH;
  const params = new URLSearchParams(isThisPage ? searchParams.toString() : "");
  params.set("status", "deleted");
  return { href: `${SKILLS_LIST_PATH}?${params.toString()}`, isThisPage };
}

const SKILLS_LIST_PATH = "/skills";
