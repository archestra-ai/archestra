import { DEFAULT_SOFT_DELETE_RETENTION_DAYS } from "@archestra/shared";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useOrganization } from "@/lib/organization.query";

const DELETED_ITEMS_HREF = "/settings/deleted-items";

/**
 * Fires the toast shown after something is deleted.
 *
 * Deleting is reversible now, and this is where a user finds that out: the
 * message says how long the item is kept, offers to undo it on the spot, and
 * points at Deleted Items for later. Without it the only signal is a delete
 * dialog that used to say "cannot be undone", which is how the reversibility
 * stayed invisible.
 *
 * `undo` is optional and should be omitted when the person deleting cannot
 * actually restore the thing — offering an Undo that 403s is worse than not
 * offering one. Restoring reuses the delete permission for agents, skills, and
 * chats, so their deleter always qualifies; projects require `project:admin`,
 * which the owner of a project need not have.
 */
export function useDeletionToast() {
  const router = useRouter();
  const { data: organization } = useOrganization();
  const { data: canViewDeletedItems } = useHasPermissions({
    organizationSettings: ["read"],
  });

  return function notifyDeleted(params: {
    message: string;
    undo?: () => void;
  }) {
    toast.success(params.message, {
      description: retentionDescription(organization),
      ...(params.undo
        ? { action: { label: "Undo", onClick: params.undo } }
        : {}),
      ...(canViewDeletedItems
        ? {
            cancel: {
              label: "View deleted items",
              onClick: () => router.push(DELETED_ITEMS_HREF),
            },
          }
        : {}),
    });
  };
}

function retentionDescription(
  organization:
    | {
        softDeleteRetentionDays?: number | null;
        softDeleteAutoPurgeEnabled?: boolean | null;
      }
    | null
    | undefined,
): string {
  // Auto-purge off means nothing reclaims it on a schedule, so promising a
  // number of days would be wrong in the one direction that matters.
  if (organization?.softDeleteAutoPurgeEnabled === false) {
    return "Kept until someone deletes it permanently.";
  }

  const days =
    organization?.softDeleteRetentionDays ?? DEFAULT_SOFT_DELETE_RETENTION_DAYS;
  return days === 1 ? "Kept for 1 day." : `Kept for ${days} days.`;
}
