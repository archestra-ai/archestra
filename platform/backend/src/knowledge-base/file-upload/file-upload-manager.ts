import { randomUUID } from "node:crypto";
import {
  type ResourceVisibilityScope,
  SUPPORTED_KNOWLEDGE_FILE_EXTENSIONS,
  SUPPORTED_KNOWLEDGE_FILE_MIME_TYPES,
} from "@archestra/shared";
import config from "@/config";
import {
  extractTextFiles,
  MAX_FILE_SIZE_BYTES,
} from "@/knowledge-base/connectors/file-upload/file-processor";
import logger from "@/logging";
import {
  AgentConnectorAssignmentModel,
  AgentModel,
  KbDocumentModel,
  KbUploadedFileModel,
  KnowledgeBaseConnectorModel,
} from "@/models";
import { taskQueueService } from "@/task-queue";
import { ApiError } from "@/types";
import {
  getBlobStorageProvider,
  getConfiguredBlobStorageProvider,
} from "./blob-storage-providers";
import type { StoredBlobPointer } from "./blob-storage-providers/types";

type UploadKnowledgeFileParams = {
  organizationId: string;
  userId: string;
  name: string;
  mimeType: string;
  content?: string;
  contentBuffer?: Buffer;
  visibility: ResourceVisibilityScope;
  teamIds: string[];
  agentIds: string[];
};

const KNOWLEDGE_FILE_CONNECTOR_NAME_PREFIX = "Knowledge File:";

class FileUploadManager {
  async uploadKnowledgeFile(params: UploadKnowledgeFileParams) {
    this.validateVisibility(params.visibility, params.teamIds);
    const rawBuffer = this.getUploadBuffer(params);
    if (rawBuffer.byteLength > MAX_FILE_SIZE_BYTES) {
      return {
        filename: params.name,
        status: "too_large" as const,
      };
    }

    if (!isSupportedKnowledgeFileFormat(params.name, params.mimeType)) {
      return {
        filename: params.name,
        status: "unsupported" as const,
      };
    }

    const extraction = await extractTextFiles(
      rawBuffer,
      params.mimeType,
      params.name,
    );
    if (extraction.extracted.length === 0) {
      return {
        filename: params.name,
        status: "extraction_failed" as const,
      };
    }

    const contentHash = KbUploadedFileModel.computeContentHash(rawBuffer);
    // Knowledge Files use a best-effort organization-wide duplicate check for
    // reusable uploads. Concurrent uploads can still race because database
    // uniqueness remains connector-scoped.
    const existing = await KbUploadedFileModel.findByOrganizationContentHash({
      organizationId: params.organizationId,
      contentHash,
    });
    if (existing) {
      return {
        filename: params.name,
        status: "duplicate" as const,
        fileId: existing.id,
      };
    }

    await this.assertAgentsBelongToOrganization({
      organizationId: params.organizationId,
      agentIds: params.agentIds,
    });

    // Create the backing connector before external blob writes so create
    // failures can clean up by connector id through cleanupFailedFileCreate.
    const connector = await KnowledgeBaseConnectorModel.create({
      organizationId: params.organizationId,
      name: `${KNOWLEDGE_FILE_CONNECTOR_NAME_PREFIX} ${params.name}`,
      description: null,
      visibility: "org-wide",
      teamIds: [],
      connectorType: "file_upload",
      config: { type: "file_upload" },
      secretId: null,
      enabled: false,
    });

    const fileId = randomUUID();
    const blobProvider = getConfiguredBlobStorageProvider();
    let blobPointer: StoredBlobPointer | null = null;
    let file: Awaited<ReturnType<typeof KbUploadedFileModel.create>>;
    try {
      blobPointer = await blobProvider.put({
        organizationId: params.organizationId,
        fileId,
        filename: params.name,
        mimeType: params.mimeType,
        data: rawBuffer,
      });

      file = await KbUploadedFileModel.create({
        id: fileId,
        connectorId: connector.id,
        organizationId: params.organizationId,
        ownerId: params.userId,
        visibility: params.visibility,
        teamIds: params.teamIds,
        originalName: params.name,
        mimeType: params.mimeType,
        fileSize: rawBuffer.byteLength,
        contentHash,
        fileData: blobPointer.dbData,
        blobStorageProvider:
          blobPointer.provider === "db" ? null : blobPointer.provider,
        blobStorageKey: blobPointer.key,
        processingStatus: "pending",
      });

      await AgentConnectorAssignmentModel.syncForAgentAssignments({
        connectorId: connector.id,
        agentIds: params.agentIds,
      });

      await taskQueueService.enqueue({
        taskType: "process_uploaded_files",
        payload: {
          connectorId: connector.id,
          fileIds: [file.id],
        },
      });
    } catch (error) {
      await this.cleanupFailedFileCreate({
        connectorId: connector.id,
        fileId,
        blobProvider,
        blobPointer,
      });
      throw error;
    }

    return {
      filename: params.name,
      status: "created" as const,
      fileId: file.id,
    };
  }

  async updateKnowledgeFile(params: {
    organizationId: string;
    fileId: string;
    visibility: ResourceVisibilityScope;
    teamIds: string[];
    agentIds: string[];
  }) {
    this.validateVisibility(params.visibility, params.teamIds);
    const file = await KbUploadedFileModel.findById(params.fileId);
    if (!file || file.organizationId !== params.organizationId) {
      throw new ApiError(404, "File not found");
    }

    await this.assertAgentsBelongToOrganization({
      organizationId: params.organizationId,
      agentIds: params.agentIds,
    });

    const visibilityChanged =
      file.visibility !== params.visibility ||
      !areStringSetsEqual(file.teamIds, params.teamIds);
    const updated = visibilityChanged
      ? await KbUploadedFileModel.updateVisibility({
          id: params.fileId,
          visibility: params.visibility,
          teamIds: params.teamIds,
        })
      : file;

    await AgentConnectorAssignmentModel.syncForAgentAssignments({
      connectorId: file.connectorId,
      agentIds: params.agentIds,
    });

    if (!visibilityChanged) {
      return updated;
    }

    await KbDocumentModel.deleteByConnectorAndSourceId({
      connectorId: file.connectorId,
      sourceId: params.fileId,
    });
    await KbUploadedFileModel.updateProcessingStatus(params.fileId, "pending");
    await taskQueueService.enqueue({
      taskType: "process_uploaded_files",
      payload: {
        connectorId: file.connectorId,
        fileIds: [params.fileId],
      },
    });

    return updated;
  }

  async deleteKnowledgeFile(params: {
    organizationId: string;
    fileId: string;
  }) {
    const file = await KbUploadedFileModel.findById(params.fileId);
    if (!file || file.organizationId !== params.organizationId) {
      throw new ApiError(404, "File not found");
    }

    const blobStorageKey = file.blobStorageKey;

    await KbUploadedFileModel.deleteKnowledgeFileGraph({
      fileId: params.fileId,
      connectorId: file.connectorId,
    });
    try {
      await getBlobStorageProvider(file.blobStorageProvider).delete({
        key: blobStorageKey,
      });
    } catch (error) {
      logger.warn(
        { error, blobStorageKey },
        "Failed to clean up uploaded knowledge file blob after delete",
      );
    }
  }

  getSupportedFileUploadConfig() {
    return {
      maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
      externalBlobStorageEnabled:
        config.kb.fileUpload.blobStorage.provider !== "db",
      blobStorageProvider: config.kb.fileUpload.blobStorage.provider,
    };
  }

  private validateVisibility(
    visibility: ResourceVisibilityScope,
    teamIds: string[],
  ) {
    if (visibility === "team" && teamIds.length === 0) {
      throw new ApiError(400, "At least one team must be selected");
    }
  }

  private getUploadBuffer(params: UploadKnowledgeFileParams) {
    if (params.contentBuffer) {
      return params.contentBuffer;
    }

    if (!params.content) {
      throw new ApiError(400, "Missing file content");
    }

    return Buffer.from(params.content, "base64");
  }

  private async assertAgentsBelongToOrganization(params: {
    organizationId: string;
    agentIds: string[];
  }) {
    const uniqueAgentIds = [...new Set(params.agentIds)];
    if (uniqueAgentIds.length === 0) return;

    const agents = await AgentModel.findBasicByOrganizationIdAndIds({
      organizationId: params.organizationId,
      agentIds: uniqueAgentIds,
    });
    if (agents.length !== uniqueAgentIds.length) {
      throw new ApiError(400, "One or more agents are not available");
    }
  }

  private async cleanupFailedFileCreate(params: {
    connectorId: string;
    fileId: string;
    blobProvider: ReturnType<typeof getConfiguredBlobStorageProvider>;
    blobPointer: StoredBlobPointer | null;
  }) {
    try {
      await KbUploadedFileModel.delete(params.fileId);
    } catch (error) {
      logger.warn(
        { error, fileId: params.fileId },
        "Failed to clean up uploaded knowledge file row after create failure",
      );
    }

    if (params.blobPointer) {
      try {
        await params.blobProvider.delete({ key: params.blobPointer.key });
      } catch (error) {
        logger.warn(
          { error, blobStorageKey: params.blobPointer.key },
          "Failed to clean up uploaded knowledge file blob after create failure",
        );
      }
    }

    try {
      await KnowledgeBaseConnectorModel.delete(params.connectorId);
    } catch (error) {
      logger.warn(
        { error, connectorId: params.connectorId },
        "Failed to clean up knowledge file connector after create failure",
      );
    }
  }
}

export const fileUploadManager = new FileUploadManager();

// ===== Internal Helpers =====

function isSupportedKnowledgeFileFormat(
  filename: string,
  mimeType: string,
): boolean {
  const extension = filename.split(".").pop()?.toLowerCase();
  if (extension && supportedKnowledgeFileExtensions.has(extension)) {
    return true;
  }

  const normalizedMimeType = mimeType.split(";")[0].trim().toLowerCase();
  return supportedKnowledgeFileMimeTypes.has(normalizedMimeType);
}

const supportedKnowledgeFileExtensions = new Set<string>(
  SUPPORTED_KNOWLEDGE_FILE_EXTENSIONS,
);
const supportedKnowledgeFileMimeTypes = new Set<string>(
  SUPPORTED_KNOWLEDGE_FILE_MIME_TYPES,
);

function areStringSetsEqual(left: string[], right: string[]) {
  if (left.length !== right.length) return false;

  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}
