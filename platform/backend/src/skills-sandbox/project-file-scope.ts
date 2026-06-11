import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { SkillSandboxFolderModel } from "@/models";
import { SkillSandboxError } from "./types";

/** The PFS scope a project imposes on every file tool used in its chats. */
export interface ProjectFileScope {
  projectId: string;
  projectName: string;
  folderId: string;
  folderName: string;
  /** The project owner — the folder lives in THEIR storage namespace. */
  folderOwnerUserId: string;
}

/**
 * Resolve the file scope of a conversation: null for non-project chats and
 * for headless (no-conversation) contexts; otherwise the project's result
 * folder. Every PFS-touching tool consults this — in a project chat, reads
 * see only the folder and writes are forced into it.
 *
 * Fails CLOSED: a project whose folder row is gone yields an error, never a
 * silent fallback to the caller's root.
 */
export async function resolveProjectFileScope(
  conversationId: string | undefined,
): Promise<ProjectFileScope | null> {
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

  const folders = await SkillSandboxFolderModel.findByIds([project.folderId]);
  const folder = folders.get(project.folderId);
  if (!folder) {
    throw new SkillSandboxError(
      `the result folder of project "${project.name}" no longer exists; file operations are disabled in this chat`,
    );
  }

  return {
    projectId: project.id,
    projectName: project.name,
    folderId: folder.id,
    folderName: folder.name,
    folderOwnerUserId: project.userId,
  };
}
