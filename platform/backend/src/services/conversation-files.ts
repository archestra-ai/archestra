import config from "@/config";
import ConversationAttachmentModel from "@/models/conversation-attachment";
import FileModel from "@/models/file";
import { resolveProjectFileScope } from "@/skills-sandbox/project-file-scope";
import { skillSandboxArtifactService } from "@/skills-sandbox/skill-sandbox-artifact-service";
import { SkillSandboxError } from "@/skills-sandbox/types";
import type { ConversationFilesResponse } from "@/types/conversation-file";
import type { SandboxFileListItem } from "@/types/skill-sandbox";

/**
 * Assembles the chat Files panel payload: `download_file` outputs, user
 * attachments, and the persistent files the agent can reach from this chat,
 * mapped to display name + the existing byte endpoint. The caller (route) is
 * responsible for verifying the requester can read the conversation.
 */
class ConversationFilesService {
  async list(params: {
    conversationId: string;
    organizationId: string;
    /** The conversation owner — whose PFS the agent works against. */
    conversationOwnerUserId: string;
    /** Who is asking; a personal PFS is only listed to its owner. */
    requestingUserId: string;
  }): Promise<ConversationFilesResponse> {
    const [artifacts, attachments, accessibleScope] = await Promise.all([
      FileModel.listMetadataByConversationId(params),
      ConversationAttachmentModel.findByConversationIdWithoutData(
        params.conversationId,
      ),
      this.listAccessibleFiles(params),
    ]);
    const { files: accessible, projectName } = accessibleScope;

    // This conversation's own outputs are PFS rows too — keep them out of
    // `myFiles` so they don't show twice.
    const generatedIds = new Set(artifacts.map((a) => a.id));

    return {
      generated: artifacts.map((a) => ({
        id: a.id,
        name: a.filename,
        mimeType: a.mimeType,
        contentUrl: `/api/skill-sandbox/artifacts/${a.id}`,
        createdAt: a.createdAt.toISOString(),
      })),
      myFiles: accessible
        .filter(
          (f): f is SandboxFileListItem & { id: string } =>
            f.id !== null && f.downloadable && !generatedIds.has(f.id),
        )
        .map((f) => ({
          id: f.id,
          name: f.filename,
          mimeType: f.mimeType,
          contentUrl: `/api/skill-sandbox/artifacts/${f.id}`,
          createdAt: f.createdAt.toISOString(),
        })),
      attachments: attachments
        // Defense in depth: the attachment finder is keyed only by
        // conversation, so re-check the org even though the route already
        // verified conversation access.
        .filter((a) => a.organizationId === params.organizationId)
        .map((a) => ({
          id: a.id,
          name: a.originalName,
          mimeType: a.mimeType,
          contentUrl: `/api/chat/attachments/${a.id}/content`,
          createdAt: a.createdAt.toISOString(),
        })),
      projectName,
    };
  }

  /**
   * The PFS files the agent can reach from this chat — mirrors the
   * search_files tool's scope. Project chat: the project's files (project
   * membership is the authorization — the route verified conversation access).
   * Personal chat: the owner's whole PFS, but only when the owner themself is
   * asking, so a shared chat doesn't expose unrelated personal files to its
   * viewers.
   */
  private async listAccessibleFiles(params: {
    conversationId: string;
    organizationId: string;
    conversationOwnerUserId: string;
    requestingUserId: string;
  }): Promise<{ files: SandboxFileListItem[]; projectName: string | null }> {
    if (!config.projects.enabled) {
      return { files: [], projectName: null };
    }

    let scope: Awaited<ReturnType<typeof resolveProjectFileScope>>;
    try {
      scope = await resolveProjectFileScope({
        conversationId: params.conversationId,
        // The requester's own access decides what the panel lists, mirroring
        // the search_files scope a project member gets in this chat.
        userId: params.requestingUserId,
        organizationId: params.organizationId,
      });
    } catch (error) {
      // Fail-closed scope (e.g. the requester lost project access): no PFS
      // file is reachable, so list none.
      if (error instanceof SkillSandboxError) {
        return { files: [], projectName: null };
      }
      throw error;
    }

    if (scope) {
      const rows = await FileModel.listByProject({
        organizationId: params.organizationId,
        projectId: scope.projectId,
      });
      return {
        files: rows.map((row) => ({
          id: row.id,
          filename: row.filename,
          mimeType: row.mimeType,
          sizeBytes: row.sizeBytes,
          createdAt: row.createdAt,
          downloadable: true,
          projectId: row.projectId,
          projectName: scope.projectName,
        })),
        projectName: scope.projectName,
      };
    }

    if (params.requestingUserId !== params.conversationOwnerUserId) {
      return { files: [], projectName: null };
    }
    const files = await skillSandboxArtifactService.listAllForUser({
      organizationId: params.organizationId,
      userId: params.conversationOwnerUserId,
    });
    return { files, projectName: null };
  }
}

export const conversationFilesService = new ConversationFilesService();
