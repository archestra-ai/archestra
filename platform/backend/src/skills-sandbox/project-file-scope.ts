import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { notDeletedConversation } from "@/database/schemas/conversation";
import { ProjectShareModel } from "@/models";
import { SkillSandboxError } from "./types";

/** The PFS scope a project imposes on every file tool used in its chats. */
export interface ProjectFileScope {
  projectId: string;
  projectName: string;
}

/**
 * Resolve the file scope of a conversation: null for non-project chats and for
 * headless (no-conversation) contexts; otherwise the owning project. Every
 * PFS-touching tool consults this — in a project chat, reads see only the
 * project's files and writes are tagged with its `project_id`.
 *
 * The caller's project access is re-checked here on EVERY use, not only at chat
 * creation: a member who has since lost access (project unshared, or removed
 * from the sharing team) must not keep reaching the project's files through a
 * chat they still own. Fails CLOSED.
 *
 * A LOCKED chat in a project resolves to null — the project holds it, but the
 * chat does not join the project's shared file space. Project files are stored
 * in plaintext and readable by every member of the project, so a write from a
 * locked chat would publish, in the clear, content derived from a conversation
 * whose whole promise is that the platform cannot read it. Its file tools stay
 * scoped to the conversation, exactly as they are in a chat with no project.
 */
export async function resolveProjectFileScope(params: {
  conversationId: string | undefined;
  userId: string;
  organizationId: string;
}): Promise<ProjectFileScope | null> {
  const { conversationId, userId, organizationId } = params;
  if (!conversationId) return null;

  const [conversation] = await db
    .select({
      projectId: schema.conversationsTable.projectId,
      lockedChat: schema.conversationsTable.lockedChat,
    })
    .from(schema.conversationsTable)
    .where(
      and(
        notDeletedConversation,
        eq(schema.conversationsTable.id, conversationId),
      ),
    );
  if (!conversation?.projectId || conversation.lockedChat) return null;

  const [project] = await db
    .select()
    .from(schema.projectsTable)
    .where(eq(schema.projectsTable.id, conversation.projectId));
  if (!project) return null;
  // Deleting a project detaches its chats (`project_id` → NULL), so this is
  // normally unreachable — but if a chat still points at a soft-deleted project,
  // fail CLOSED rather than silently degrading to a personal (no-project) scope,
  // which would let file tools read/write outside the hidden project.
  if (project.deletedAt) {
    throw new SkillSandboxError(
      `project "${project.name}" was deleted; file operations are disabled in this chat`,
    );
  }

  const canAccess = await ProjectShareModel.userCanAccessProject({
    project,
    userId,
    organizationId,
  });
  if (!canAccess) {
    throw new SkillSandboxError(
      `you no longer have access to project "${project.name}"; file operations are disabled in this chat`,
    );
  }

  return { projectId: project.id, projectName: project.name };
}

/**
 * Resolve the file scope of an explicitly named project — the headless path for
 * callers with no conversation to derive scope from (an external MCP client on a
 * gateway, which finds the id via `list_projects` / `get_project`).
 *
 * Authorization is identical to {@link resolveProjectFileScope}: the project
 * must live in the caller's organization, not be soft-deleted, and be reachable
 * by them (owner, or shared with them / a team they are in). Re-checked on EVERY
 * call, and fails CLOSED.
 *
 * `project:admin` oversight deliberately does NOT apply. Reading another
 * member's project files is an oversight action that belongs to the REST/UI
 * surface; an agent tool grants only the caller's own reach.
 *
 * "Missing" and "no access" raise the SAME error on purpose, so probing ids
 * cannot be used to discover which projects exist.
 */
export async function resolveExplicitProjectFileScope(params: {
  projectId: string;
  userId: string;
  organizationId: string;
}): Promise<ProjectFileScope> {
  const { projectId, userId, organizationId } = params;

  const denied = new SkillSandboxError(
    `no project ${projectId} exists, or you do not have access to it`,
  );

  const [project] = await db
    .select()
    .from(schema.projectsTable)
    .where(eq(schema.projectsTable.id, projectId));
  if (
    !project ||
    project.organizationId !== organizationId ||
    project.deletedAt
  )
    throw denied;

  const canAccess = await ProjectShareModel.userCanAccessProject({
    project,
    userId,
    organizationId,
  });
  if (!canAccess) throw denied;

  return { projectId: project.id, projectName: project.name };
}
