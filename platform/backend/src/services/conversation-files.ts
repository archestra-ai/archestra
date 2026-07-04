import ConversationModel from "@/models/conversation";
import ConversationAttachmentModel from "@/models/conversation-attachment";
import FileModel from "@/models/file";
import {
  type ProjectFileScope,
  resolveProjectFileScope,
} from "@/skills-sandbox/project-file-scope";
import { SkillSandboxError } from "@/skills-sandbox/types";
import { ApiError } from "@/types";
import type { ConversationFilesResponse } from "@/types/conversation-file";

type ProjectFile = {
  id: string;
  filename: string;
  mimeType: string;
  createdAt: Date;
};

/**
 * Assembles the chat Files panel payload: this chat's own outputs, user
 * attachments, and — for a project chat — every file in the project, mapped to
 * display name + the existing byte endpoint. The caller (route) is responsible
 * for verifying the requester can read the conversation.
 */
class ConversationFilesService {
  async list(params: {
    conversationId: string;
    organizationId: string;
    /** Who is asking; their project access gates the project files. */
    requestingUserId: string;
  }): Promise<ConversationFilesResponse> {
    const [artifacts, attachments, projectScope, canManageFiles] =
      await Promise.all([
        FileModel.listMetadataByConversationId(params),
        ConversationAttachmentModel.findByConversationIdWithoutData(
          params.conversationId,
        ),
        this.listProjectFiles(params),
        ConversationModel.isOwnedBy({
          id: params.conversationId,
          userId: params.requestingUserId,
          organizationId: params.organizationId,
        }),
      ]);
    const { files: projectFiles, projectName } = projectScope;

    // A file created in this chat is already in `generated`; keep it out of
    // `projectFiles` so a project chat doesn't list it twice.
    const generatedIds = new Set(artifacts.map((a) => a.id));

    return {
      generated: artifacts.map((a) => ({
        id: a.id,
        name: a.filename,
        mimeType: a.mimeType,
        contentUrl: `/api/skill-sandbox/artifacts/${a.id}`,
        createdAt: a.createdAt.toISOString(),
      })),
      projectFiles: projectFiles
        .filter((f) => !generatedIds.has(f.id))
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
      canManageFiles,
    };
  }

  /**
   * Soft-delete a chat attachment. Mutating, so it is owner-gated (not the
   * read-only `findReadableConversationById` used by the byte endpoint): only
   * the conversation owner may remove its attachments, even from a chat a
   * member can otherwise read via a share or project membership.
   */
  async deleteAttachment(params: {
    attachmentId: string;
    userId: string;
    organizationId: string;
  }): Promise<void> {
    const meta = await ConversationAttachmentModel.findById(
      params.attachmentId,
    );
    if (!meta) {
      throw new ApiError(404, "Attachment not found");
    }
    if (meta.organizationId !== params.organizationId) {
      throw new ApiError(403, "Attachment belongs to a different org");
    }
    const owns = await ConversationModel.isOwnedBy({
      id: meta.conversationId,
      userId: params.userId,
      organizationId: params.organizationId,
    });
    if (!owns) {
      throw new ApiError(403, "No access to the owning conversation");
    }
    await ConversationAttachmentModel.softDelete(params.attachmentId);
  }

  /**
   * Every file in the chat's project, or none for a personal chat. Project
   * access is the authorization (the route verified conversation access);
   * `resolveProjectFileScope` re-checks it on every call and fails closed, so a
   * member who has since lost access can't reach the project's files through a
   * chat they still own. `projectName` labels the section.
   */
  private async listProjectFiles(params: {
    conversationId: string;
    organizationId: string;
    requestingUserId: string;
  }): Promise<{ files: ProjectFile[]; projectName: string | null }> {
    let scope: ProjectFileScope | null = null;
    try {
      scope = await resolveProjectFileScope({
        conversationId: params.conversationId,
        userId: params.requestingUserId,
        organizationId: params.organizationId,
      });
    } catch (error) {
      // Fail-closed scope: a member who has since lost share access can't reach
      // the project's files through a chat they still own.
      if (!(error instanceof SkillSandboxError)) throw error;
    }

    if (!scope) {
      return { files: [], projectName: null };
    }

    const files = await FileModel.listByProject({
      organizationId: params.organizationId,
      projectId: scope.projectId,
    });
    return { files, projectName: scope.projectName };
  }
}

export const conversationFilesService = new ConversationFilesService();
