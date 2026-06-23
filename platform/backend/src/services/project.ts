import {
  ProjectModel,
  ProjectNameExistsError,
  ProjectPinModel,
  ProjectShareModel,
} from "@/models";
import { fileStore } from "@/skills-sandbox/file-store";
import { validateProjectName } from "@/skills-sandbox/project-name";
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
    icon?: string | null;
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
        icon: params.icon ?? null,
      });
    } catch (error) {
      if (error instanceof ProjectNameExistsError) {
        throw new ApiError(
          409,
          `a project named "${name}" already exists in this organization`,
        );
      }
      throw error;
    }
  }

  async list(params: {
    organizationId: string;
    userId: string;
  }): Promise<ProjectListItem[]> {
    const projects = await ProjectShareModel.listAccessibleProjects(params);
    const projectIds = projects.map((p) => p.id);
    const [counts, pins] = await Promise.all([
      ProjectModel.countConversations(projectIds),
      ProjectPinModel.getPinnedAtForProjects({
        userId: params.userId,
        projectIds,
      }),
    ]);
    return projects.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      icon: p.icon,
      isOwner: p.userId === params.userId,
      conversationCount: counts.get(p.id) ?? 0,
      visibility: p.visibility,
      pinnedAt: pins.get(p.id) ?? null,
      createdAt: p.createdAt,
    }));
  }

  async get(params: {
    id: string;
    organizationId: string;
    userId: string;
  }): Promise<ProjectDetail> {
    const project = await this.requireReadable(params);
    const [share, counts, pins] = await Promise.all([
      ProjectShareModel.findByProjectId(project.id),
      ProjectModel.countConversations([project.id]),
      ProjectPinModel.getPinnedAtForProjects({
        userId: params.userId,
        projectIds: [project.id],
      }),
    ]);
    const isOwner = project.userId === params.userId;
    return {
      id: project.id,
      name: project.name,
      description: project.description,
      icon: project.icon,
      isOwner,
      conversationCount: counts.get(project.id) ?? 0,
      visibility: share?.visibility ?? null,
      // share targets are the owner's business only
      shareTeamIds: isOwner ? (share?.teamIds ?? []) : null,
      pinnedAt: pins.get(project.id) ?? null,
      createdAt: project.createdAt,
    };
  }

  /** Update owner-editable fields (name/description/icon); only provided keys change. */
  async update(params: {
    id: string;
    organizationId: string;
    userId: string;
    name?: string;
    description?: string | null;
    icon?: string | null;
  }): Promise<void> {
    await this.requireOwned(params);
    const fields: {
      name?: string;
      description?: string | null;
      icon?: string | null;
    } = {};
    if (params.name !== undefined) {
      const name = params.name.trim();
      const invalid = validateProjectName(name);
      if (invalid) {
        throw new ApiError(400, `project name is invalid: ${invalid}`);
      }
      fields.name = name;
    }
    if (params.description !== undefined)
      fields.description = params.description;
    if (params.icon !== undefined) fields.icon = params.icon;
    if (Object.keys(fields).length === 0) return;
    try {
      await ProjectModel.update({ id: params.id, fields });
    } catch (error) {
      if (error instanceof ProjectNameExistsError) {
        throw new ApiError(
          409,
          `a project named "${fields.name}" already exists`,
        );
      }
      throw error;
    }
  }

  /**
   * The project's instructions text ("" when never saved). Readable by anyone
   * with project access — the instructions steer every chat in the project.
   */
  async getInstructions(params: {
    id: string;
    organizationId: string;
    userId: string;
  }): Promise<{ content: string }> {
    const project = await this.requireReadable(params);
    const content = await fileStore.readProjectInstructions({
      organizationId: params.organizationId,
      projectId: project.id,
    });
    return { content: content ?? "" };
  }

  /**
   * Create or replace the project's instructions (owner only). The first save
   * materializes the real `instructions.md` file; empty content is kept (an
   * empty file is simply not injected into chats), never deleted.
   */
  async setInstructions(params: {
    id: string;
    organizationId: string;
    userId: string;
    content: string;
  }): Promise<void> {
    const project = await this.requireOwned(params);
    await fileStore.writeProjectInstructions({
      organizationId: params.organizationId,
      userId: params.userId,
      projectId: project.id,
      content: params.content,
    });
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

  /**
   * Chats SET NULL and survive; the project's file rows are deleted with it (FK
   * cascade). Externally-stored bytes (filesystem provider) live outside Postgres,
   * so purge them first — the cascade would otherwise orphan them on disk.
   */
  async delete(params: {
    id: string;
    organizationId: string;
    userId: string;
  }): Promise<void> {
    await this.requireOwned(params);
    await fileStore.purgeProjectBytes({
      organizationId: params.organizationId,
      projectId: params.id,
    });
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
    return fileStore.search({
      organizationId: params.organizationId,
      userId: params.userId,
      scope: {
        kind: "project",
        projectId: project.id,
        projectName: project.name,
      },
    });
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

  /** Pin a project to the caller's sidebar (any reader may pin). */
  async pin(params: {
    id: string;
    organizationId: string;
    userId: string;
  }): Promise<void> {
    await this.requireReadable(params);
    await ProjectPinModel.pin({ userId: params.userId, projectId: params.id });
  }

  /**
   * Remove the caller's pin. Intentionally does NOT check readability: an owner
   * can unshare a project after you pinned it, and you must still be able to
   * clear your own stale pin. Scoped to the caller's own row; idempotent.
   */
  async unpin(params: {
    id: string;
    organizationId: string;
    userId: string;
  }): Promise<void> {
    await ProjectPinModel.unpin({
      userId: params.userId,
      projectId: params.id,
    });
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
