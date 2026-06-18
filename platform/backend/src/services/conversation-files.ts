import config from "@/config";
import ConversationAttachmentModel from "@/models/conversation-attachment";
import ConversationFileTouchModel from "@/models/conversation-file-touch";
import FileModel from "@/models/file";
import { resolveProjectFileScope } from "@/skills-sandbox/project-file-scope";
import { SkillSandboxError } from "@/skills-sandbox/types";
import type { ConversationFilesResponse } from "@/types/conversation-file";

type ReferencedFile = {
  id: string;
  filename: string;
  mimeType: string;
  createdAt: Date;
};

/**
 * Assembles the chat Files panel payload: this chat's own outputs, user
 * attachments, and the pre-existing files the agent actually touched here
 * (read/edited), mapped to display name + the existing byte endpoint. The
 * caller (route) is responsible for verifying the requester can read the
 * conversation.
 */
class ConversationFilesService {
  async list(params: {
    conversationId: string;
    organizationId: string;
    /** The conversation owner — whose PFS the agent works against. */
    conversationOwnerUserId: string;
    /** Who is asking; referenced personal files are only listed to the owner. */
    requestingUserId: string;
  }): Promise<ConversationFilesResponse> {
    const [artifacts, attachments, referencedScope] = await Promise.all([
      FileModel.listMetadataByConversationId(params),
      ConversationAttachmentModel.findByConversationIdWithoutData(
        params.conversationId,
      ),
      this.listReferencedFiles(params),
    ]);
    const { files: referenced, projectName } = referencedScope;

    // A file created in this chat is already in `generated`; keep it out of
    // `referenced` so it doesn't show twice if it was also read back later.
    const generatedIds = new Set(artifacts.map((a) => a.id));

    return {
      generated: artifacts.map((a) => ({
        id: a.id,
        name: a.filename,
        mimeType: a.mimeType,
        contentUrl: `/api/skill-sandbox/artifacts/${a.id}`,
        createdAt: a.createdAt.toISOString(),
      })),
      referenced: referenced
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
    };
  }

  /**
   * The pre-existing files the agent touched in this chat. Project chat:
   * project membership is the authorization (the route verified conversation
   * access), and `projectName` labels the section. Personal chat: the touched
   * files are the owner's personal files, listed only when the owner themself
   * is asking, so a shared chat doesn't expose them to its viewers.
   */
  private async listReferencedFiles(params: {
    conversationId: string;
    organizationId: string;
    conversationOwnerUserId: string;
    requestingUserId: string;
  }): Promise<{ files: ReferencedFile[]; projectName: string | null }> {
    if (!config.projects.enabled) {
      return { files: [], projectName: null };
    }

    let scope: Awaited<ReturnType<typeof resolveProjectFileScope>>;
    try {
      scope = await resolveProjectFileScope({
        conversationId: params.conversationId,
        userId: params.requestingUserId,
        organizationId: params.organizationId,
      });
    } catch (error) {
      // Fail-closed scope (e.g. the requester lost project access): list none.
      if (error instanceof SkillSandboxError) {
        return { files: [], projectName: null };
      }
      throw error;
    }

    if (!scope && params.requestingUserId !== params.conversationOwnerUserId) {
      return { files: [], projectName: null };
    }

    const files = await ConversationFileTouchModel.listReferencedFiles({
      organizationId: params.organizationId,
      conversationId: params.conversationId,
      scope: scope
        ? { kind: "project", projectId: scope.projectId }
        : { kind: "personal", userId: params.conversationOwnerUserId },
    });
    return { files, projectName: scope?.projectName ?? null };
  }
}

export const conversationFilesService = new ConversationFilesService();
