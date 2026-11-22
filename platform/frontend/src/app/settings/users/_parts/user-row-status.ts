import {
  MESSAGING_CHANNEL_LABELS,
  type MessagingChannelId,
} from "@archestra/shared";
import { formatDate } from "@/lib/utils/date-time";

/**
 * The "Joined" text of a user who has not signed in yet, with where they
 * came from in brackets: SCIM provisioning by an identity provider, or
 * auto-provisioning from a messaging channel. Plain "Pending" when neither
 * is known.
 */
export function pendingSignupLabel(pending: {
  provider: string | null;
  scimProvisioned: boolean;
}): string {
  if (pending.scimProvisioned) {
    return "Pending (identity provider)";
  }
  if (pending.provider) {
    const channel =
      MESSAGING_CHANNEL_LABELS[pending.provider as MessagingChannelId] ??
      pending.provider;
    return `Pending (${channel})`;
  }
  return "Pending";
}

/**
 * The note shown when hovering the row of a user the identity provider
 * deactivated. A deactivated user stays listed, with their data, until an
 * admin removes them, so the note names the row action that does it.
 *
 * @param softDeleted when the identity provider deactivated the user (ISO date)
 */
export function deactivatedUserNote(softDeleted: string): string {
  const date = formatDate({ date: softDeleted, dateFormat: "MMM d, yyyy" });
  return `Your identity provider deactivated this user on ${date}. They can't sign in, but their data is kept. To delete them completely, choose Remove user in the row menu.`;
}
