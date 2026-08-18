import config from "@/config";
import {
  buildUserAccessControlList,
  findAccessTokensForUserCached,
  knowledgeSourceAccessControlService,
} from "@/knowledge-base";
import { extractText } from "@/knowledge-base/file-upload/extract";
import { resolveOcrConfig } from "@/knowledge-base/kb-llm-client";
import {
  OCR_RUN_PAGE_BUDGET,
  type OcrRunContext,
} from "@/knowledge-base/pdf-ocr";
import logger from "@/logging";
import { KbDocumentModel, KbFileModel, TeamModel, UserModel } from "@/models";
import { readRowBytes } from "@/skills-sandbox/file-storage";
import type { AclEntry, BatchAnalysisRowSource } from "@/types";

type ResolvedSource = {
  text: string;
  /** True when `text` was cut to the configured ceiling. Surfaced to the model
   *  and recorded on the cell, so a partial answer is never mistaken for a
   *  complete one. */
  truncated: boolean;
};

type SourceResolution =
  | { ok: true; source: ResolvedSource }
  | { ok: false; error: string };

/**
 * Turn a row's opaque source reference into text for the model.
 *
 * This is the only place that knows what a source type means, which is what
 * keeps the runner generic: adding a new source type is a new branch here plus
 * a variant in `BatchAnalysisRowSourceSchema`, and nothing else changes.
 *
 * Access is always resolved as the analysis's creator, never as the worker. A
 * run can therefore never read something its creator could not read directly,
 * and a document that later becomes inaccessible starts failing its cells
 * rather than silently serving stale content.
 */
export async function resolveRowSource(params: {
  source: BatchAnalysisRowSource;
  organizationId: string;
  actingUserId: string;
}): Promise<SourceResolution> {
  switch (params.source.type) {
    case "inline_text":
      return { ok: true, source: applyLimit(params.source.text) };
    case "kb_document":
      return resolveKbDocument({
        documentId: params.source.documentId,
        organizationId: params.organizationId,
        actingUserId: params.actingUserId,
      });
    case "kb_file":
      return resolveKbFile({
        fileId: params.source.fileId,
        organizationId: params.organizationId,
        actingUserId: params.actingUserId,
      });
  }
}

/**
 * A repository file, read through the same visibility filter the files page
 * uses — as the CREATOR, per the doctrine above, so sharing an analysis never
 * widens who the underlying file is readable by. Text is re-extracted from the
 * stored bytes on every run rather than cached at upload, so an extraction fix
 * benefits existing analyses on their next run.
 */
async function resolveKbFile(params: {
  fileId: string;
  organizationId: string;
  actingUserId: string;
}): Promise<SourceResolution> {
  const teams = await TeamModel.getUserTeamsForOrganization({
    userId: params.actingUserId,
    organizationId: params.organizationId,
  });
  const file = await KbFileModel.findById({
    id: params.fileId,
    organizationId: params.organizationId,
    viewer: {
      userId: params.actingUserId,
      teamIds: teams.map((team) => team.id),
      canManageAll: false,
    },
  });
  if (!file) {
    // Indistinguishable from "no such file" on purpose, like kb_document.
    return { ok: false, error: "Source file not found or not accessible" };
  }

  try {
    const bytes = await readRowBytes(file);
    const { text } = await extractText({
      buffer: bytes,
      filename: file.filename,
      ocr: await armOcr(params.organizationId),
    });
    return { ok: true, source: applyLimit(text) };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Could not read the source file",
    };
  }
}

async function resolveKbDocument(params: {
  documentId: string;
  organizationId: string;
  actingUserId: string;
}): Promise<SourceResolution> {
  const access =
    await knowledgeSourceAccessControlService.buildAccessControlContext({
      userId: params.actingUserId,
      organizationId: params.organizationId,
    });

  // Admin-equivalent callers bypass the ACL on the retrieval path, so they
  // bypass it here too — anything else would make an analysis see LESS than the
  // same user's own knowledge search, which reads as a bug rather than a policy.
  if (access.canReadAll) {
    const document = await KbDocumentModel.findByIdForAcl({
      documentId: params.documentId,
      organizationId: params.organizationId,
      userAcl: [],
      bypassAcl: true,
    });
    return document
      ? { ok: true, source: applyLimit(document.content) }
      : { ok: false, error: "Source document not found" };
  }

  const user = await UserModel.getById(params.actingUserId);
  if (!user?.email) {
    // No resolvable identity means no `user_email:` or `group:` grant can match.
    // Fail closed and say so, rather than quietly falling back to org-wide.
    return {
      ok: false,
      error: "Cannot resolve the analysis owner's identity to check access",
    };
  }

  // `group:` / `container:` tokens are scoped per connector, so the document's
  // connector has to be known before the ACL can be assembled.
  const connectorId = await KbDocumentModel.findConnectorIdById({
    documentId: params.documentId,
    organizationId: params.organizationId,
  });
  if (!connectorId) {
    return { ok: false, error: "Source document not found" };
  }

  const accessTokens = await findAccessTokensForUserCached({
    memberEmail: user.email,
    userId: params.actingUserId,
    connectorIds: [connectorId],
  });

  const userAcl: AclEntry[] = buildUserAccessControlList({
    userEmail: user.email,
    teamIds: access.teamIds,
    groupTokens: accessTokens,
  });

  const document = await KbDocumentModel.findByIdForAcl({
    documentId: params.documentId,
    organizationId: params.organizationId,
    userAcl,
    bypassAcl: false,
  });

  if (!document) {
    // Indistinguishable from "no such document" on purpose — a run must not
    // become an oracle for the existence of documents its owner cannot read.
    return { ok: false, error: "Source document not found or not accessible" };
  }

  return { ok: true, source: applyLimit(document.content) };
}

function applyLimit(text: string): ResolvedSource {
  const limit = config.batchAnalysis.maxSourceChars;
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, limit), truncated: true };
}

/**
 * OCR context for one row's source extraction, when the organization has a
 * Document OCR pair configured. A scanned knowledge file is then analysed
 * from its transcription instead of failing as unreadable. Per-row rather
 * than per-run: rows run as independent queue tasks, so the per-document
 * page cap is the effective spend bound. Degraded, never fatal.
 */
async function armOcr(
  organizationId: string,
): Promise<OcrRunContext | undefined> {
  try {
    const config = await resolveOcrConfig(organizationId);
    if (!config) return undefined;
    return {
      config,
      connectorId: null,
      deadlineAt: Number.POSITIVE_INFINITY,
      budget: { remainingPages: OCR_RUN_PAGE_BUDGET },
      log: logger,
      connectorType: "file_upload",
    };
  } catch (error) {
    logger.warn(
      {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      },
      "[BatchAnalysis] OCR is configured but unusable — resolving source without it",
    );
    return undefined;
  }
}
