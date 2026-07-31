import logger from "@/logging";
import {
  AgentModel,
  ConversationModel,
  ConversationShareModel,
  ProjectModel,
  SkillModel,
} from "@/models";
import { ProjectNameExistsError } from "@/models/project";
import { activeChatRunService } from "@/services/active-chat-run";
import type { DeletedItem } from "@/types";

type RestoreResult =
  | { status: "restored" }
  /** Already active, or purged between listing and this call. */
  | { status: "not_found" }
  /**
   * Something took the name, slug, or singleton role the entity gave up when it
   * was deleted. The message is user-facing and names the specific clash.
   */
  | { status: "conflict"; message: string }
  /** The entity type has no restore path at all (apps). */
  | { status: "unsupported"; message: string };

/**
 * Bring one soft-deleted entity back from Deleted Items.
 *
 * Every branch delegates to the same model calls the entity's own restore
 * endpoint uses, so the per-entity side effects survive: a project resumes its
 * schedules forward-only, and a conversation finalizes its stopped run and comes
 * back private. What this does NOT reproduce is those endpoints' ownership
 * checks — the caller here is an organization admin acting on other people's
 * rows, which is the whole point of a central trash, and the route gates that on
 * `organizationSettings: ["update"]` before reaching this.
 *
 * Deleting frees names and slugs (the unique indexes are partial on
 * `deleted_at IS NULL`), so restoring can genuinely fail against something
 * created since. That surfaces as `conflict` rather than an exception.
 */
export async function restoreDeletedItem(params: {
  item: DeletedItem;
  organizationId: string;
}): Promise<RestoreResult> {
  const { item, organizationId } = params;

  switch (item.entityType) {
    case "agent":
      return restoreAgent(item.id, organizationId);
    case "skill":
      return restoreSkill(item.id, organizationId);
    case "project":
      return restoreProject(item.id, organizationId);
    case "conversation":
      return restoreConversation(item.id, organizationId);
    case "app":
      return {
        status: "unsupported",
        message:
          "Apps cannot be restored. Deleting an app also removes the MCP server backing it, so the app would come back without its tools.",
      };
  }
}

// ===== Internal helpers =====

async function restoreAgent(
  id: string,
  organizationId: string,
): Promise<RestoreResult> {
  const agent = await AgentModel.findDeletedByIdForOrganization(
    id,
    organizationId,
  );
  if (!agent) return { status: "not_found" };

  const conflict = await AgentModel.getRestoreConflictMessage(agent);
  if (conflict) return { status: "conflict", message: conflict };

  const restored = await AgentModel.restore(id);
  return restored ? { status: "restored" } : { status: "not_found" };
}

async function restoreSkill(
  id: string,
  organizationId: string,
): Promise<RestoreResult> {
  const skill = await SkillModel.findDeletedById(id, organizationId);
  if (!skill) return { status: "not_found" };

  const conflict = await SkillModel.getRestoreConflictMessage(skill);
  if (conflict) return { status: "conflict", message: conflict };

  const restored = await SkillModel.restore(id);
  return restored ? { status: "restored" } : { status: "not_found" };
}

async function restoreProject(
  id: string,
  organizationId: string,
): Promise<RestoreResult> {
  const project = await ProjectModel.findDeletedByIdForOrganization({
    id,
    organizationId,
  });
  if (!project) return { status: "not_found" };

  try {
    const restored = await ProjectModel.restore({
      id,
      organizationId,
      name: project.name,
    });
    return restored ? { status: "restored" } : { status: "not_found" };
  } catch (error) {
    // The per-user name index is partial on active rows, so a project created
    // with this name while it sat in the trash blocks the restore. Renaming on
    // the way back is the fix, and it lives on the project's own restore
    // endpoint — this page does not ask for a new name.
    if (error instanceof ProjectNameExistsError) {
      return {
        status: "conflict",
        message: `A project named "${project.name}" already exists. Rename it, or restore this one from the project's own restore endpoint with a new name.`,
      };
    }
    throw error;
  }
}

async function restoreConversation(
  id: string,
  organizationId: string,
): Promise<RestoreResult> {
  const conversation = await ConversationModel.findDeletedByIdForOrganization(
    id,
    organizationId,
  );
  if (!conversation) return { status: "not_found" };

  // Performed as the owner: both the restore and the share revocation below are
  // owner-scoped, and the row supplied the owner.
  const restored = await ConversationModel.restore(
    id,
    conversation.userId,
    organizationId,
  );
  if (restored === 0) return { status: "not_found" };

  // Same two transition-gated side effects as the owner's own restore endpoint.
  // Finalizing the run is best-effort — a restore must not fail over stream
  // bookkeeping — but the share revocation is not: a chat that came back still
  // publicly readable is exactly the disclosure this prevents.
  try {
    await activeChatRunService.cancelRunForRestoredConversation(id);
  } catch (error) {
    logger.warn(
      { error, conversationId: id },
      "Failed to finalize the stopped chat run on conversation restore",
    );
  }

  await ConversationShareModel.delete({
    conversationId: id,
    organizationId,
    userId: conversation.userId,
  });

  return { status: "restored" };
}
