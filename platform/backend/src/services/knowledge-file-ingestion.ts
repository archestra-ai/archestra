import config from "@/config";
import { extractText } from "@/knowledge-base/file-upload/extract";
import {
  hashFileContent,
  indexFilesIntoKnowledgeBase,
} from "@/knowledge-base/file-upload/index-file";
import { KbFileModel, OrganizationModel } from "@/models";
import { ApiError } from "@/types";
import { isUniqueConstraintError } from "@/utils/db";
import { findAccessibleKnowledgeBase } from "./knowledge-base-access";

export async function upsertKnowledgeFile(params: {
  id: string;
  organizationId: string;
  userId: string;
  filename: string;
  mimeType: string;
  content: string;
  knowledgeBaseId: string;
}) {
  const maxBytes = config.knowledgeFiles.maxUploadBytes;
  if (Buffer.byteLength(params.content, "utf8") > Math.ceil(maxBytes * 1.4)) {
    throw new ApiError(413, "File exceeds the upload limit");
  }
  const data = Buffer.from(params.content, "base64");
  if (data.byteLength > maxBytes)
    throw new ApiError(413, "File exceeds the upload limit");
  const existing = await KbFileModel.findById({
    id: params.id,
    organizationId: params.organizationId,
    viewer: { userId: params.userId, teamIds: [], canManageAll: true },
  });
  if (
    existing &&
    (existing.uploadedBy !== params.userId || existing.storageProvider !== "db")
  ) {
    throw new ApiError(409, "This file cannot be replaced by this uploader");
  }
  const linked = await KbFileModel.findKnowledgeBasesForFiles(
    existing ? [existing.id] : [],
  );
  const knowledgeBaseIds = [
    ...new Set([
      params.knowledgeBaseId,
      ...(linked.get(params.id) ?? []).map((kb) => kb.id),
    ]),
  ];
  for (const id of knowledgeBaseIds) {
    await findAccessibleKnowledgeBase({
      id,
      organizationId: params.organizationId,
      userId: params.userId,
    });
  }
  const org = await OrganizationModel.getById(params.organizationId);
  const extracted = await extractText({
    buffer: data,
    filename: params.filename,
    acceptTextlessPdf: !!org?.ocrChatApiKeyId && !!org.ocrModel,
  });
  if (!extracted.text.trim() && !extracted.warning) {
    throw new ApiError(400, "File has no readable content");
  }
  let file: Awaited<ReturnType<typeof KbFileModel.upsertContent>>;
  try {
    file = await KbFileModel.upsertContent({
      id: params.id,
      organizationId: params.organizationId,
      uploadedBy: params.userId,
      filename: params.filename,
      mimeType: params.mimeType,
      data,
      contentHash: hashFileContent(data),
    });
  } catch (error) {
    if (isUniqueConstraintError(error))
      throw new ApiError(
        409,
        "A different file already uses that filename in this location",
      );
    throw error;
  }
  if (!file)
    throw new ApiError(409, "This file cannot be replaced by this uploader");
  const uploaderEmailById = await KbFileModel.findUploaderEmails([file.id]);
  const results = [];
  for (const knowledgeBaseId of knowledgeBaseIds) {
    results.push({
      knowledgeBaseId,
      ...(await indexFilesIntoKnowledgeBase({
        fileIds: [file.id],
        knowledgeBaseId,
        organizationId: params.organizationId,
        uploaderEmailById,
      })),
    });
  }
  return { id: file.id, results };
}
