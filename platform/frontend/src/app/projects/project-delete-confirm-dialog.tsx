import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { useScheduleTriggers } from "@/lib/schedule-trigger.query";
import { buildProjectDeleteDescription } from "./project-delete-description";

/**
 * Delete-confirmation for a project that surfaces how many scheduled tasks the
 * deletion will take with it (the project_id FK cascades). Only mount it when a
 * deletion is actually being confirmed so the schedule count is fetched lazily.
 */
export function ProjectDeleteConfirmDialog({
  project,
  open,
  onOpenChange,
  onConfirm,
  isPending,
}: {
  project: { id: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  isPending: boolean;
}) {
  const { data } = useScheduleTriggers({ projectId: project.id });
  const scheduleCount = data?.pagination.total ?? 0;

  return (
    <DeleteConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete ${project.name}?`}
      description={buildProjectDeleteDescription(scheduleCount)}
      isPending={isPending}
      onConfirm={onConfirm}
      confirmLabel="Delete"
      pendingLabel="Deleting..."
    />
  );
}
