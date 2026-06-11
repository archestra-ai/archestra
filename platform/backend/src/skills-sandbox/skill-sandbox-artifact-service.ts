import {
  SkillSandboxFileModel,
  SkillSandboxFolderModel,
  SkillSandboxModel,
} from "@/models";
import type {
  SandboxFileListItem,
  SandboxFolderListItem,
  SkillSandboxFile,
} from "@/types";
import { getSandboxFileStorage, storageFilename } from "./file-storage";
import { SandboxFileMissingError } from "./file-storage-filesystem";

/** Bytes + metadata of a PFS file resolved for sandbox upload. */
type ResolvedXFile = {
  data: Buffer;
  mimeType: string;
  originalName: string;
};

/** Why an x_file reference failed to resolve. */
type XFileResolutionError = {
  error: "not_found" | "ambiguous" | "missing_bytes" | "outside_project_folder";
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
   * Fetch an artifact the caller may access: the producing sandbox's owner,
   * or the owner of the folder the artifact sits in (project folders collect
   * results from every project member's chats). Null for "not found" AND
   * "not yours" alike, so 404s can't probe other users' ids.
   */
  async getArtifactForUser(params: {
    artifactId: string;
    organizationId: string;
    userId: string;
  }): Promise<SkillSandboxFile | null> {
    const artifact = await SkillSandboxFileModel.findArtifactById(
      params.artifactId,
    );
    if (!artifact) return null;
    const sandbox = await SkillSandboxModel.findById(artifact.sandboxId);
    if (!sandbox || sandbox.organizationId !== params.organizationId) {
      return null;
    }
    if (sandbox.userId !== params.userId) {
      const folder = artifact.folderId
        ? (await SkillSandboxFolderModel.findByIds([artifact.folderId])).get(
            artifact.folderId,
          )
        : undefined;
      if (
        !folder ||
        folder.userId !== params.userId ||
        folder.organizationId !== params.organizationId
      ) {
        return null;
      }
    }
    return artifact;
  }

  /**
   * Delete an artifact: the row first (the DB is authoritative — a row whose
   * bytes outlive it merely resurfaces as a non-downloadable orphan in
   * filesystem mode), then the external bytes, best-effort. Same access rule
   * as reading: sandbox owner or folder owner.
   */
  async deleteArtifactForUser(params: {
    artifactId: string;
    organizationId: string;
    userId: string;
  }): Promise<boolean> {
    const artifact = await this.getArtifactForUser(params);
    if (!artifact) return false;
    await SkillSandboxFileModel.deleteArtifactById(artifact.id);
    await getSandboxFileStorage()
      .delete({
        provider: artifact.storageProvider,
        objectKey: artifact.objectKey,
      })
      .catch(() => {});
    return true;
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
    /**
     * Project file scope (project chats only). When set, only files inside
     * the project folder resolve — and they resolve from the FOLDER OWNER's
     * namespace, authorized by project membership rather than file ownership.
     */
    scope?: {
      folderId: string;
      folderName: string;
      folderOwnerUserId: string;
    } | null;
  }): Promise<ResolvedXFile | XFileResolutionError> {
    const scope = params.scope ?? null;

    if (params.id) {
      const artifact = await SkillSandboxFileModel.findArtifactById(params.id);
      if (!artifact) return { error: "not_found" };
      const sandbox = await SkillSandboxModel.findById(artifact.sandboxId);
      if (!sandbox || sandbox.organizationId !== params.organizationId) {
        return { error: "not_found" };
      }
      if (scope) {
        // in a project chat the folder is the boundary, not file ownership.
        if (artifact.folderId !== scope.folderId) {
          return { error: "outside_project_folder" };
        }
      } else if (sandbox.userId !== params.userId) {
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

    const folder = scope ? scope.folderName : (params.folder ?? null);
    if (scope && params.folder && params.folder !== scope.folderName) {
      return { error: "outside_project_folder" };
    }
    const filename = params.filename ?? "";
    const namespaceUserId = scope ? scope.folderOwnerUserId : params.userId;
    const { files } = await this.listAllForUser({
      organizationId: params.organizationId,
      userId: namespaceUserId,
    });
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
          userId: namespaceUserId,
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
