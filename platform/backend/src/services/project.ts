import {
  ProjectModel,
  ProjectNameExistsError,
  ProjectShareModel,
  SandboxFolderExistsError,
  SkillSandboxFolderModel,
} from "@/models";
import { getSandboxFileStorage } from "@/skills-sandbox/file-storage";
import { validateSandboxFolderName } from "@/skills-sandbox/folder-name";
import { skillSandboxArtifactService } from "@/skills-sandbox/skill-sandbox-artifact-service";
import type {
  Project,
  ProjectConversationItem,
  ProjectDetail,
  ProjectListItem,
  ProjectShareVisibility,
  SandboxFileListItem,
} from "@/types";
import { ApiError } from "@/types";

/**
 * Projects: named collections of chats with a dedicated PFS result folder.
 * Creating a project creates its folder (same name, owner's namespace) —
 * users no longer create folders directly. Mutations are owner-only; read
 * access is governed by the project share (see ProjectShareModel).
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

    let folderId: string;
    try {
      await getSandboxFileStorage().ensureFolderDir({
        userId: params.userId,
        name,
      });
      const folder = await SkillSandboxFolderModel.create({
        organizationId: params.organizationId,
        userId: params.userId,
        name,
      });
      folderId = folder.id;
    } catch (error) {
      if (error instanceof SandboxFolderExistsError) {
        throw new ApiError(
          409,
          `a project or folder named "${name}" already exists`,
        );
      }
      throw error;
    }

    try {
      return await ProjectModel.create({
        organizationId: params.organizationId,
        userId: params.userId,
        name,
        description: params.description,
        folderId,
      });
    } catch (error) {
      // roll the folder row back so a failed create leaves nothing behind
      // (no bytes exist yet; the empty directory is harmless and adoptable).
      await SkillSandboxFolderModel.deleteById(folderId).catch(() => {});
      if (error instanceof ProjectNameExistsError) {
        throw new ApiError(409, error.message);
      }
      throw error;
    }
  }

  async list(params: {
    organizationId: string;
    userId: string;
  }): Promise<ProjectListItem[]> {
    const projects = await ProjectShareModel.listAccessibleProjects(params);
    const [counts, folders] = await Promise.all([
      ProjectModel.countConversations(projects.map((p) => p.id)),
      SkillSandboxFolderModel.findByIds(projects.map((p) => p.folderId)),
    ]);
    return projects.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      isOwner: p.userId === params.userId,
      folderName: folders.get(p.folderId)?.name ?? p.name,
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
    const [share, counts, folders] = await Promise.all([
      ProjectShareModel.findByProjectId(project.id),
      ProjectModel.countConversations([project.id]),
      SkillSandboxFolderModel.findByIds([project.folderId]),
    ]);
    const isOwner = project.userId === params.userId;
    return {
      id: project.id,
      name: project.name,
      description: project.description,
      isOwner,
      folderName: folders.get(project.folderId)?.name ?? project.name,
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
   * Files in the project's result folder. The listing runs in the FOLDER
   * OWNER's namespace — project read access (not file ownership) is the
   * authorization, mirroring the in-chat tool scope.
   */
  async listFiles(params: {
    id: string;
    organizationId: string;
    userId: string;
  }): Promise<SandboxFileListItem[]> {
    const project = await this.requireReadable(params);
    const folders = await SkillSandboxFolderModel.findByIds([project.folderId]);
    const folderName = folders.get(project.folderId)?.name;
    if (!folderName) return [];
    const { files } = await skillSandboxArtifactService.listAllForUser({
      organizationId: params.organizationId,
      userId: project.userId,
    });
    return files.filter((f) => f.folder === folderName);
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
