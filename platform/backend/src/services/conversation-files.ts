import { basename } from "node:path";
import ConversationAttachmentModel from "@/models/conversation-attachment";
import SkillSandboxFileModel from "@/models/skill-sandbox-file";
import type { ConversationFilesResponse } from "@/types/conversation-file";

/**
 * Assembles the chat Files panel payload: `download_file` outputs and user
 * attachments, mapped to display name + the existing byte endpoint. The caller
 * (route) is responsible for verifying the requester can read the conversation.
 */
class ConversationFilesService {
  async list(params: {
    conversationId: string;
    organizationId: string;
  }): Promise<ConversationFilesResponse> {
    const [artifacts, attachments] = await Promise.all([
      SkillSandboxFileModel.listArtifactMetadataByConversationId(params),
      ConversationAttachmentModel.findByConversationIdWithoutData(
        params.conversationId,
      ),
    ]);

    return {
      generated: artifacts.map((a) => ({
        id: a.id,
        name: basename(a.path),
        mimeType: a.mimeType,
        contentUrl: `/api/skill-sandbox/artifacts/${a.id}`,
        createdAt: a.createdAt.toISOString(),
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
    };
  }
}

export const conversationFilesService = new ConversationFilesService();
