import {
  FileModel,
  FolderModel,
  ProjectModel,
  ProjectNameExistsError,
  ProjectShareModel,
} from "@/models";
import { validateSandboxFolderName } from "@/skills-sandbox/folder-name";
import type {
  Project,
  ProjectConversationItem,
  ProjectDetail,
  ProjectListItem,
  ProjectShareVisibility,
  SandboxArtifactRow,
  SandboxFileListItem,
  SandboxFolderListItem,
} from "@/types";
import { ApiError } from "@/types";

/** Map a stored file row to the wire shape the file surfaces use. */
function toFileListItem(row: SandboxArtifactRow): SandboxFileListItem {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
    downloadable: true,
    folder: row.folderName,
  };
}

/**
 * Projects: named collections of chats with a dedicated result folder owned by
 * the project (`folders.project_id`). Creating a project creates its folder —
 * users no longer create folders directly. Mutations are owner-only; access to
 * the project (and so its folder's files) is governed by the project share
 * (see ProjectShareModel).
 */
class ProjectService {
  async create(params: {
    organizationId: string;
    userId: string;
    name: string;
    description: string | null;
  }): Promise<Project> {
    const name = params.name.trim();
    const invalid = validateSandboxFolderName(name);
    if (invalid) {
      throw new ApiError(400, `project name is invalid: ${invalid}`);
    }

    // The project row carries the unique (user, name) — create it first so a
    // name clash is caught here, then attach its result folder.
    let project: Project;
    try {
      project = await ProjectModel.create({
        organizationId: params.organizationId,
        userId: params.userId,
        name,
        description: params.description,
      });
    } catch (error) {
      if (error instanceof ProjectNameExistsError) {
        throw new ApiError(409, `a project named "${name}" already exists`);
      }
      throw error;
    }

    try {
      await FolderModel.createForProject({
        organizationId: params.organizationId,
        projectId: project.id,
        name,
      });
    } catch (error) {
      // roll the project row back so a failed create leaves nothing behind.
      await ProjectModel.delete(project.id).catch(() => {});
      throw error;
    }
    return project;
  }

  async list(params: {
    organizationId: string;
    userId: string;
  }): Promise<ProjectListItem[]> {
    const projects = await ProjectShareModel.listAccessibleProjects(params);
    const [counts, folders] = await Promise.all([
      ProjectModel.countConversations(projects.map((p) => p.id)),
      FolderModel.findByProjectIds(projects.map((p) => p.id)),
    ]);
    return projects.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      isOwner: p.userId === params.userId,
      folderName: folders.get(p.id)?.name ?? p.name,
      conversationCount: counts.get(p.id) ?? 0,
      visibility: p.visibility,
      createdAt: p.createdAt,
    }));
  }

  async get(params: {
    id: string;
    organizationId: string;
    userId: string;
  }): Promise<ProjectDetail> {
    const project = await this.requireReadable(params);
    const [share, counts, folder] = await Promise.all([
      ProjectShareModel.findByProjectId(project.id),
      ProjectModel.countConversations([project.id]),
      FolderModel.findByProjectId(project.id),
    ]);
    const isOwner = project.userId === params.userId;
    return {
      id: project.id,
      name: project.name,
      description: project.description,
      isOwner,
      folderName: folder?.name ?? project.name,
      conversationCount: counts.get(project.id) ?? 0,
      visibility: share?.visibility ?? null,
      // share targets are the owner's business only
      shareTeamIds: isOwner ? (share?.teamIds ?? []) : null,
      createdAt: project.createdAt,
    };
  }

  async updateDescription(params: {
    id: string;
    organizationId: string;
    userId: string;
    description: string | null;
  }): Promise<void> {
    await this.requireOwned(params);
    await ProjectModel.updateDescription(params);
  }

  /** Upsert (or remove, when visibility is null) the project's share. */
  async setShare(params: {
    id: string;
    organizationId: string;
    userId: string;
    visibility: ProjectShareVisibility | null;
    teamIds: string[];
  }): Promise<void> {
    await this.requireOwned(params);
    if (params.visibility === null) {
      await ProjectShareModel.remove(params.id);
      return;
    }
    await ProjectShareModel.upsert({
      projectId: params.id,
      organizationId: params.organizationId,
      createdByUserId: params.userId,
      visibility: params.visibility,
      teamIds: params.teamIds,
    });
  }

  /** Conversations and the folder survive (FK SET NULL / no folder delete). */
  async delete(params: {
    id: string;
    organizationId: string;
    userId: string;
  }): Promise<void> {
    await this.requireOwned(params);
    await ProjectModel.delete(params.id);
  }

  /**
   * Files in the project's result folder. Project access (not file ownership)
   * is the authorization, mirroring the in-chat tool scope.
   */
  async listFiles(params: {
    id: string;
    organizationId: string;
    userId: string;
  }): Promise<SandboxFileListItem[]> {
    const project = await this.requireReadable(params);
    const folder = await FolderModel.findByProjectId(project.id);
    if (!folder) return [];
    const rows = await FileModel.listByFolders({
      organizationId: params.organizationId,
      folderIds: [folder.id],
    });
    return rows.map(toFileListItem);
  }

  /**
   * Result folders of EVERY project the user can access (owned or shared),
   * with their files — merged into the My Files page next to the user's own
   * PFS. The owner sees their project folders the same way every member does
   * (project folders never appear in the personal `listForUser`).
   */
  async listSharedFolders(params: {
    organizationId: string;
    userId: string;
  }): Promise<{
    folders: SandboxFolderListItem[];
    files: SandboxFileListItem[];
  }> {
    const shared = await ProjectShareModel.listAccessibleProjects(params);
    if (shared.length === 0) return { folders: [], files: [] };
    const folderRows = await FolderModel.findByProjectIds(
      shared.map((p) => p.id),
    );
    const folderList = [...folderRows.values()];
    if (folderList.length === 0) return { folders: [], files: [] };
    const fileRows = await FileModel.listByFolders({
      organizationId: params.organizationId,
      folderIds: folderList.map((f) => f.id),
    });
    return {
      folders: folderList.map((f) => ({
        id: f.id,
        name: f.name,
        createdAt: f.createdAt,
      })),
      files: fileRows.map(toFileListItem),
    };
  }

  async listConversations(params: {
    id: string;
    organizationId: string;
    userId: string;
  }): Promise<ProjectConversationItem[]> {
    const project = await this.requireReadable(params);
    const rows = await ProjectModel.listConversations(project.id);
    return rows.map((row) => ({
      ...row,
      readOnly: row.authorUserId !== params.userId,
    }));
  }

  /** Project the caller may read, by id; "no access" reads as 404. */
  private async requireReadable(params: {
    id: string;
    organizationId: string;
    userId: string;
  }): Promise<Project> {
    const project = await ProjectModel.findById(params.id);
    if (
      !project ||
      !(await ProjectShareModel.userCanAccessProject({
        project,
        userId: params.userId,
        organizationId: params.organizationId,
      }))
    ) {
      throw new ApiError(404, "Project not found");
    }
    return project;
  }

  /** Project the caller owns, by id; "not yours" reads as 404 too. */
  private async requireOwned(params: {
    id: string;
    organizationId: string;
    userId: string;
  }): Promise<Project> {
    const project = await ProjectModel.findByIdForOwner({
      id: params.id,
      userId: params.userId,
      organizationId: params.organizationId,
    });
    if (!project) {
      throw new ApiError(404, "Project not found");
    }
    return project;
  }
}

export const projectService = new ProjectService();
