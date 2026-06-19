import { FileModel, ProjectModel, ProjectShareModel } from "@/models";
import type { PersistedFile, SandboxFileListItem } from "@/types";
import { FileBytesMissingError, getFileBytesStorage } from "./file-storage";

type ResolvedMyFile = {
  /** The resolved file's id — lets callers record a read touch. */
  fileId: string;
  data: Buffer;
  mimeType: string;
  originalName: string;
};

type MyFileResolutionError = {
  error: "not_found" | "ambiguous" | "missing_bytes" | "outside_project";
};

function toListItem(row: {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
  projectId: string | null;
}): SandboxFileListItem {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
    downloadable: true,
    projectId: row.projectId,
    projectName: null,
  };
}

/**
 * The user's persistent file system (PFS / My Files): listing and byte access
 * for the upload path. Rows live in the `files` table; access is the file's
 * author for personal files, or project membership for project files.
 */
class SkillSandboxArtifactService {
  /** Files produced in one conversation (all downloadable). */
  async listForConversation(params: {
    organizationId: string;
    userId: string;
    conversationId: string;
  }): Promise<SandboxFileListItem[]> {
    return (await FileModel.listByConversation(params)).map(toListItem);
  }

  /** The user's own personal files (no project files). */
  async listAllForUser(params: {
    organizationId: string;
    userId: string;
  }): Promise<SandboxFileListItem[]> {
    return (await FileModel.listForUser(params)).map(toListItem);
  }

  /**
   * Fetch a file the caller may access — same rule for read and delete: the
   * author for a personal file, or anyone with access to the owning project for
   * a project file. Null for "not found" AND "not yours" alike, so 404s can't
   * probe ids.
   */
  async getArtifactForUser(params: {
    artifactId: string;
    organizationId: string;
    userId: string;
  }): Promise<PersistedFile | null> {
    const file = await FileModel.findById(params.artifactId);
    if (!file || file.organizationId !== params.organizationId) return null;
    if (file.projectId) {
      const project = await ProjectModel.findById(file.projectId);
      if (!project) return null;
      const canAccess = await ProjectShareModel.userCanAccessProject({
        project,
        userId: params.userId,
        organizationId: params.organizationId,
      });
      return canAccess ? file : null;
    }
    return file.userId === params.userId ? file : null;
  }

  /** Delete a file (row first), then any external bytes (no-op under Postgres). */
  async deleteArtifactForUser(params: {
    artifactId: string;
    organizationId: string;
    userId: string;
  }): Promise<boolean> {
    const file = await this.getArtifactForUser(params);
    if (!file) return false;
    await FileModel.deleteById(file.id);
    await getFileBytesStorage()
      .delete({ provider: file.storageProvider, objectKey: file.objectKey })
      .catch(() => {});
    return true;
  }

  /**
   * Resolve a `my_file` upload source (by row id, or by `filename` within the
   * chat's flat scope) to its bytes. A duplicated filename is reported as
   * ambiguous rather than picking one silently.
   */
  async resolveMyFileSource(params: {
    organizationId: string;
    userId: string;
    id?: string;
    filename?: string;
    scope?: { projectId: string } | null;
  }): Promise<ResolvedMyFile | MyFileResolutionError> {
    const scope = params.scope ?? null;

    if (params.id) {
      const file = await FileModel.findById(params.id);
      if (!file || file.organizationId !== params.organizationId) {
        return { error: "not_found" };
      }
      if (scope) {
        if (file.projectId !== scope.projectId) {
          return { error: "outside_project" };
        }
      } else if (file.userId !== params.userId || file.projectId != null) {
        return { error: "not_found" };
      }
      return this.readBytes(file);
    }

    const filename = params.filename ?? "";
    const candidates = scope
      ? await FileModel.listByProject({
          organizationId: params.organizationId,
          projectId: scope.projectId,
        })
      : await FileModel.listForUser({
          organizationId: params.organizationId,
          userId: params.userId,
        });
    const matches = candidates.filter((f) => f.filename === filename);
    if (matches.length === 0) return { error: "not_found" };
    if (matches.length > 1) return { error: "ambiguous" };

    const file = await FileModel.findById(matches[0].id);
    if (!file) return { error: "not_found" };
    return this.readBytes(file);
  }

  private async readBytes(
    file: PersistedFile,
  ): Promise<ResolvedMyFile | MyFileResolutionError> {
    try {
      return {
        fileId: file.id,
        data: await getFileBytesStorage().get(file),
        mimeType: file.mimeType,
        originalName: file.filename,
      };
    } catch (error) {
      if (error instanceof FileBytesMissingError) {
        return { error: "missing_bytes" };
      }
      throw error;
    }
  }
}

export const skillSandboxArtifactService = new SkillSandboxArtifactService();
