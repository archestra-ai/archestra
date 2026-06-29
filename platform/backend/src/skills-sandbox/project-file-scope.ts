import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
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
 */
export async function resolveProjectFileScope(params: {
  conversationId: string | undefined;
  userId: string;
  organizationId: string;
}): Promise<ProjectFileScope | null> {
  const { conversationId, userId, organizationId } = params;
  if (!conversationId) return null;

  const [conversation] = await db
    .select({ projectId: schema.conversationsTable.projectId })
    .from(schema.conversationsTable)
    .where(eq(schema.conversationsTable.id, conversationId));
  if (!conversation?.projectId) return null;

  const [project] = await db
    .select()
    .from(schema.projectsTable)
    .where(eq(schema.projectsTable.id, conversation.projectId));
  if (!project) return null;

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
