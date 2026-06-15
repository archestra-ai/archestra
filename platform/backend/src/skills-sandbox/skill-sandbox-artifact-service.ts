import {
  FileModel,
  FolderModel,
  ProjectModel,
  ProjectShareModel,
} from "@/models";
import type {
  PersistedFile,
  SandboxFileListItem,
  SandboxFolderListItem,
} from "@/types";
import { getSandboxFileStorage } from "./file-storage";
import { SandboxFileMissingError } from "./file-storage-filesystem";

/** Bytes + metadata of a PFS file resolved for sandbox upload. */
type ResolvedMyFile = {
  data: Buffer;
  mimeType: string;
  originalName: string;
};

/** Why an my_file reference failed to resolve. */
type MyFileResolutionError = {
  error: "not_found" | "ambiguous" | "missing_bytes" | "outside_project_folder";
};

/**
 * The user's persistent file system (PFS / My Files): listing, folders, and
 * byte access for the upload path. Rows live in the `files` table; the
 * storage router decides what a listing means per backend (db = the rows;
 * filesystem = the on-disk directory tree).
 */
class SkillSandboxArtifactService {
  /** Surface A: files produced in one conversation (all downloadable). */
  async listForConversation(params: {
    organizationId: string;
    userId: string;
    conversationId: string;
  }): Promise<SandboxFileListItem[]> {
    const rows = await FileModel.listByConversation(params);
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
      FileModel.listForUser(params),
      FolderModel.listByUser(params),
    ]);
    return getSandboxFileStorage().listUserFiles({
      userId: params.userId,
      rows,
      folderRows,
    });
  }

  /**
   * Fetch a file the caller may access: its author, the owner of the folder
   * it sits in (project folders collect results from every project member's
   * chats), or — with `allowSharedProjectRead` — a member of the project
   * sharing that folder (byte reads only; deletion keeps the stricter rule).
   * Null for "not found" AND "not yours" alike, so 404s can't probe ids.
   */
  async getArtifactForUser(params: {
    artifactId: string;
    organizationId: string;
    userId: string;
    allowSharedProjectRead?: boolean;
  }): Promise<PersistedFile | null> {
    const file = await FileModel.findById(params.artifactId);
    if (!file || file.organizationId !== params.organizationId) return null;
    if (file.userId !== params.userId) {
      const folder = file.folderId
        ? (await FolderModel.findByIds([file.folderId])).get(file.folderId)
        : undefined;
      if (!folder || folder.organizationId !== params.organizationId) {
        return null;
      }
      if (folder.userId !== params.userId) {
        if (!params.allowSharedProjectRead) return null;
        const project = await ProjectModel.findByFolderId(folder.id);
        if (!project) return null;
        const canAccess = await ProjectShareModel.userCanAccessProject({
          project,
          userId: params.userId,
          organizationId: params.organizationId,
        });
        if (!canAccess) return null;
      }
    }
    return file;
  }

  /**
   * Delete a file: the row first (the DB is authoritative — a row whose bytes
   * outlive it merely resurfaces as a non-downloadable orphan in filesystem
   * mode), then the external bytes, best-effort. Author or folder owner only.
   */
  async deleteArtifactForUser(params: {
    artifactId: string;
    organizationId: string;
    userId: string;
  }): Promise<boolean> {
    const file = await this.getArtifactForUser(params);
    if (!file) return false;
    await FileModel.deleteById(file.id);
    await getSandboxFileStorage()
      .delete({
        provider: file.storageProvider,
        objectKey: file.objectKey,
      })
      .catch(() => {});
    return true;
  }

  /**
   * Resolve an `my_file` upload source — a reference to a PFS file by row id or
   * by location (`filename` + optional `folder`) — to its bytes. Location
   * resolution goes through the same listing the user sees, so it reaches
   * orphans (filesystem files with no row) too; a duplicated filename is
   * reported as ambiguous rather than picking one silently.
   */
  async resolveMyFileSource(params: {
    organizationId: string;
    userId: string;
    id?: string;
    filename?: string;
    folder?: string;
    scope?: {
      folderId: string;
      folderName: string;
      folderOwnerUserId: string;
    } | null;
  }): Promise<ResolvedMyFile | MyFileResolutionError> {
    const scope = params.scope ?? null;

    if (params.id) {
      const file = await FileModel.findById(params.id);
      if (!file || file.organizationId !== params.organizationId) {
        return { error: "not_found" };
      }
      if (scope) {
        // in a project chat the folder is the boundary, not file ownership.
        if (file.folderId !== scope.folderId) {
          return { error: "outside_project_folder" };
        }
      } else if (file.userId !== params.userId) {
        return { error: "not_found" };
      }
      try {
        return {
          data: await getSandboxFileStorage().get(file),
          mimeType: file.mimeType,
          originalName: file.filename,
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
        const file = await FileModel.findById(match.id);
        if (!file) return { error: "not_found" };
        return {
          data: await getSandboxFileStorage().get(file),
          mimeType: file.mimeType,
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
