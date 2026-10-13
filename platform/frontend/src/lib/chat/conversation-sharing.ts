// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { ResourcePermissionGrant } from "@archestra/shared";

/**
 * Whether a chat is shared, judged by its own grants only. Inherited grants
 * from the policy for every chat (by default, read for admins) apply to all
 * chats alike, so they never mean this chat was shared. Mirrors the backend's
 * `sharedAudience`, which feeds `conversation.share`.
 */
export function isConversationShared(params: {
  grants: Pick<ResourcePermissionGrant, "subject" | "actions">[];
  ownerId: string | undefined;
}): boolean {
  return params.grants.some(
    (grant) =>
      grant.actions.includes("read") &&
      !(grant.subject.type === "user" && grant.subject.id === params.ownerId),
  );
}
