import {
  FileModel,
  ProjectModel,
  ProjectNameExistsError,
  ProjectShareModel,
} from "@/models";
import { validateProjectName } from "@/skills-sandbox/project-name";
import type {
  Project,
  ProjectConversationItem,
  ProjectDetail,
  ProjectListItem,
  ProjectShareVisibility,
  SandboxArtifactRow,
  SandboxFileListItem,
} from "@/types";
import { ApiError } from "@/types";

/** Map a stored file row to the wire shape the file surfaces use. */
function toFileListItem(
  row: SandboxArtifactRow,
  projectName: string | null,
): SandboxFileListItem {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
    downloadable: true,
    projectId: row.projectId,
    projectName,
  };
}

/**
 * Projects: named collections of chats that own a set of result files
 * (`files.project_id`). Mutations are owner-only; access to the project (and so
 * its files) is governed by the project share (see ProjectShareModel).
 */
class ProjectService {
  async create(params: {
    organizationId: string;
    userId: string;
    name: string;
    description: string | null;
  }): Promise<Project> {
    const name = params.name.trim();
    const invalid = validateProjectName(name);
    if (invalid) {
      throw new ApiError(400, `project name is invalid: ${invalid}`);
    }
    try {
      return await ProjectModel.create({
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
  }

  async list(params: {
    organizationId: string;
    userId: string;
  }): Promise<ProjectListItem[]> {
    const projects = await ProjectShareModel.listAccessibleProjects(params);
    const counts = await ProjectModel.countConversations(
      projects.map((p) => p.id),
    );
    return projects.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      isOwner: p.userId === params.userId,
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
    const [share, counts] = await Promise.all([
      ProjectShareModel.findByProjectId(project.id),
      ProjectModel.countConversations([project.id]),
    ]);
    const isOwner = project.userId === params.userId;
    return {
      id: project.id,
      name: project.name,
      description: project.description,
      isOwner,
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

  /** Chats SET NULL and survive; the project's files are deleted with it (FK cascade). */
  async delete(params: {
    id: string;
    organizationId: string;
    userId: string;
  }): Promise<void> {
    await this.requireOwned(params);
    await ProjectModel.delete(params.id);
  }

  /**
   * Files owned by the project. Project access (not file ownership) is the
   * authorization, mirroring the in-chat tool scope.
   */
  async listFiles(params: {
    id: string;
    organizationId: string;
    userId: string;
  }): Promise<SandboxFileListItem[]> {
    const project = await this.requireReadable(params);
    const rows = await FileModel.listByProject({
      organizationId: params.organizationId,
      projectId: project.id,
    });
    return rows.map((r) => toFileListItem(r, project.name));
  }

  /**
   * Files of EVERY project the user can access (owned or shared), tagged by
   * project — merged into the My Files page next to the user's own files.
   */
  async listSharedProjectFiles(params: {
    organizationId: string;
    userId: string;
  }): Promise<SandboxFileListItem[]> {
    const projects = await ProjectShareModel.listAccessibleProjects(params);
    if (projects.length === 0) return [];
    const names = new Map(projects.map((p) => [p.id, p.name]));
    const rows = await FileModel.listByProjects({
      organizationId: params.organizationId,
      projectIds: projects.map((p) => p.id),
    });
    return rows.map((r) =>
      toFileListItem(r, r.projectId ? (names.get(r.projectId) ?? null) : null),
    );
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
