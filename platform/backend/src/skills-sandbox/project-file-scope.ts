import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { FolderModel, ProjectShareModel } from "@/models";
import { SkillSandboxError } from "./types";

/** The PFS scope a project imposes on every file tool used in its chats. */
export interface ProjectFileScope {
  projectId: string;
  projectName: string;
  folderId: string;
  folderName: string;
  /** The bytes belong to the project, not to any one member. */
  namespace: { kind: "project"; projectId: string };
}

/**
 * Resolve the file scope of a conversation: null for non-project chats and
 * for headless (no-conversation) contexts; otherwise the project's result
 * folder. Every PFS-touching tool consults this — in a project chat, reads
 * see only the folder and writes are forced into it.
 *
 * The caller's project access is re-checked here on EVERY use, not only at
 * chat creation: a member who has since lost access (project unshared, or
 * removed from the sharing team) must not keep reaching the result folder
 * through a chat they still own.
 *
 * Fails CLOSED: a caller who can no longer access the project, or a project
 * whose folder row is gone, yields an error — never a silent fallback to the
 * caller's personal root.
 */
export async function resolveProjectFileScope(params: {
  conversationId: string | undefined;
  /** The caller whose current project access governs this chat's file tools. */
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

  // Access derives from CURRENT project membership, not from the fact that
  // this chat once belonged to the project — revoked access takes effect on
  // the next file operation.
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

  const folder = await FolderModel.findByProjectId(project.id);
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
    namespace: { kind: "project", projectId: project.id },
  };
}
