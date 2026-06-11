import {
  SandboxFolderExistsError,
  SkillSandboxFileModel,
  SkillSandboxFolderModel,
  SkillSandboxModel,
} from "@/models";
import type {
  SandboxFileListItem,
  SandboxFolderListItem,
  SkillSandboxFile,
  SkillSandboxFolder,
} from "@/types";
import { ApiError } from "@/types";
import { getSandboxFileStorage, storageFilename } from "./file-storage";
import { SandboxFileMissingError } from "./file-storage-filesystem";
import { validateSandboxFolderName } from "./folder-name";

/** Bytes + metadata of a PFS file resolved for sandbox upload. */
type ResolvedXFile = {
  data: Buffer;
  mimeType: string;
  originalName: string;
};

/** Why an x_file reference failed to resolve. */
type XFileResolutionError = {
  error: "not_found" | "ambiguous" | "missing_bytes";
};

/**
 * The user's persistent file system (PFS / X-Files): listing, folders, and
 * byte access for the upload path. Row enumeration stays in the models; the
 * storage router decides what a listing means per backend (db = the rows;
 * filesystem = the on-disk directory tree).
 */
class SkillSandboxArtifactService {
  /** Surface A: artifacts produced in one conversation (all downloadable). */
  async listForConversation(params: {
    organizationId: string;
    userId: string;
    conversationId: string;
  }): Promise<SandboxFileListItem[]> {
    const rows = await SkillSandboxFileModel.listUserArtifacts(params);
    return rows.map((row) => ({
      id: row.id,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      createdAt: row.createdAt,
      downloadable: true,
      folder: row.folderName,
    }));
  }

  /** Surface B: the user's whole PFS; backend hidden behind the router. */
  async listAllForUser(params: {
    organizationId: string;
    userId: string;
  }): Promise<{
    folders: SandboxFolderListItem[];
    files: SandboxFileListItem[];
  }> {
    const [rows, folderRows] = await Promise.all([
      SkillSandboxFileModel.listUserArtifacts(params),
      SkillSandboxFolderModel.listByUser(params),
    ]);
    return getSandboxFileStorage().listUserFiles({
      userId: params.userId,
      rows,
      folderRows,
    });
  }

  /**
   * Fetch an uploaded input for byte serving, scoped to the calling user.
   * Returns null for "not found" AND "not yours" so the route's 404 cannot be
   * used to probe other users' upload ids.
   */
  async getUploadForUser(params: {
    uploadId: string;
    organizationId: string;
    userId: string;
  }): Promise<SkillSandboxFile | null> {
    const upload = await SkillSandboxFileModel.findUploadById(params.uploadId);
    if (!upload) return null;
    const sandbox = await SkillSandboxModel.findById(upload.sandboxId);
    if (
      !sandbox ||
      sandbox.organizationId !== params.organizationId ||
      sandbox.userId !== params.userId
    ) {
      return null;
    }
    return upload;
  }

  /**
   * Resolve an `x_file` upload source — a reference to a PFS file by row id or
   * by location (`filename` + optional `folder`) — to its bytes. Location
   * resolution goes through the same listing the user sees, so it reaches
   * orphans (filesystem files with no row) too; a duplicated filename (possible
   * in db mode, where names aren't unique) is reported as ambiguous rather than
   * picking one silently.
   */
  async resolveXFileSource(params: {
    organizationId: string;
    userId: string;
    id?: string;
    filename?: string;
    folder?: string;
  }): Promise<ResolvedXFile | XFileResolutionError> {
    if (params.id) {
      const artifact = await SkillSandboxFileModel.findArtifactById(params.id);
      if (!artifact) return { error: "not_found" };
      const sandbox = await SkillSandboxModel.findById(artifact.sandboxId);
      if (
        !sandbox ||
        sandbox.organizationId !== params.organizationId ||
        sandbox.userId !== params.userId
      ) {
        return { error: "not_found" };
      }
      try {
        return {
          data: await getSandboxFileStorage().get(artifact),
          mimeType: artifact.mimeType,
          originalName: storageFilename({
            originalName: artifact.originalName,
            path: artifact.path,
          }),
        };
      } catch (error) {
        if (error instanceof SandboxFileMissingError) {
          return { error: "missing_bytes" };
        }
        throw error;
      }
    }

    const folder = params.folder ?? null;
    const filename = params.filename ?? "";
    const { files } = await this.listAllForUser(params);
    const matches = files.filter(
      (f) => f.filename === filename && f.folder === folder,
    );
    if (matches.length === 0) return { error: "not_found" };
    if (matches.length > 1) return { error: "ambiguous" };
    const match = matches[0];

    try {
      if (match.id) {
        const artifact = await SkillSandboxFileModel.findArtifactById(match.id);
        if (!artifact) return { error: "not_found" };
        return {
          data: await getSandboxFileStorage().get(artifact),
          mimeType: artifact.mimeType,
          originalName: match.filename,
        };
      }
      // orphan: no row — read by location from the storage tree.
      return {
        data: await getSandboxFileStorage().readUserFile({
          userId: params.userId,
          folder,
          filename: match.filename,
        }),
        mimeType: match.mimeType,
        originalName: match.filename,
      };
    } catch (error) {
      if (error instanceof SandboxFileMissingError) {
        return { error: "missing_bytes" };
      }
      throw error;
    }
  }
}

export const skillSandboxArtifactService = new SkillSandboxArtifactService();
