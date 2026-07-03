import {
  MAX_PROJECT_UPLOAD_BYTES,
  MAX_PROJECT_UPLOAD_MB,
  PROJECT_INSTRUCTIONS_FILENAME,
} from "@archestra/shared";
import { userHasPermission } from "@/auth";
import {
  ConversationModel,
  ConversationNotOwnedError,
  FileNameExistsError,
  ProjectAlreadyAssignedError,
  ProjectModel,
  ProjectNameExistsError,
  ProjectPinModel,
  ProjectShareModel,
  UserModel,
} from "@/models";
import { fileStore } from "@/skills-sandbox/file-store";
import { validateProjectName } from "@/skills-sandbox/project-name";
import type {
  Project,
  ProjectConversationItem,
  ProjectDetail,
  ProjectListItem,
  ProjectListScope,
  ProjectShareVisibility,
  ProjectViewerRole,
  SandboxFileListItem,
} from "@/types";
import { ApiError } from "@/types";
import {
  nextAvailableName,
  sanitizeUploadFilename,
} from "@/utils/upload-filename";

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

  /**
   * Turn one of the caller's chats into a project: create the project, move the
   * chat into it, and re-point the chat's files to the project (see
   * {@link ProjectModel.createFromConversation}). Owner-only; only `user`
   * chats are eligible (scheduled-run conversations are rejected) and a chat
   * already in a project can't seed another. `name` defaults to the chat title.
   */
  async createProjectFromConversation(params: {
    organizationId: string;
    userId: string;
    conversationId: string;
    name?: string | null;
    description?: string | null;
    icon?: string | null;
  }): Promise<{ project: Project; filesMoved: number }> {
    const meta = await ConversationModel.getOwnedMeta({
      id: params.conversationId,
      userId: params.userId,
      organizationId: params.organizationId,
    });
    if (!meta) {
      throw new ApiError(404, "Conversation not found");
    }
    if (meta.origin !== "user") {
      throw new ApiError(409, "Only user chats can be turned into a project");
    }
    if (meta.projectId) {
      throw new ApiError(409, "This chat already belongs to a project");
    }

    const name =
      params.name?.trim() || meta.title?.trim() || "Untitled project";
    const invalid = validateProjectName(name);
    if (invalid) {
      throw new ApiError(400, `project name is invalid: ${invalid}`);
    }

    try {
      return await ProjectModel.createFromConversation({
        organizationId: params.organizationId,
        userId: params.userId,
        conversationId: params.conversationId,
        name,
        description: params.description ?? null,
        icon: params.icon ?? null,
      });
    } catch (error) {
      if (error instanceof ConversationNotOwnedError) {
        throw new ApiError(404, "Conversation not found");
      }
      if (error instanceof ProjectAlreadyAssignedError) {
        throw new ApiError(409, "This chat already belongs to a project");
      }
      if (error instanceof ProjectNameExistsError) {
        throw new ApiError(
          409,
          `a project named "${name}" already exists in this organization`,
        );
      }
      throw error;
    }
  }

  /**
   * Projects for the list view, scoped + searched, mirroring the Agents filter.
   * `scope` is the project's share visibility (mutually exclusive): `personal`
   * (private), `team` (shared with teams — narrow with `teamIds`), or `org`
   * (org-wide); omitted = everything the caller can see. Admins draw from ALL
   * org projects and can filter `personal` by owner via `authorIds` /
   * `excludeAuthorIds` (the "My / Other users" sub-filter); everyone else is
   * limited to their accessible set. `viewerRole` is the caller's real
   * relationship to each project (owner / shared / admin-oversight).
   */
  async list(params: {
    organizationId: string;
    userId: string;
    isProjectAdmin?: boolean;
    scope?: ProjectListScope;
    teamIds?: string[];
    authorIds?: string[];
    excludeAuthorIds?: string[];
    search?: string;
  }): Promise<ProjectListItem[]> {
    const { organizationId, userId, scope } = params;

    // What the caller can actually reach (owner ∪ org/team-shared-to-them): the
    // non-admin base, and how admins tell "shared" from "oversight" access.
    const accessible = await ProjectShareModel.listAccessibleProjects({
      userId,
      organizationId,
    });
    const accessibleIds = new Set(accessible.map((p) => p.id));

    // A project:admin oversees every project; everyone else sees only theirs.
    const base = params.isProjectAdmin
      ? await ProjectShareModel.listAllOrgProjects({ organizationId })
      : accessible;

    let candidates = base.map((project) => ({
      project,
      viewerRole: (project.userId === userId
        ? "owner"
        : accessibleIds.has(project.id)
          ? "shared"
          : "admin") as ProjectViewerRole,
    }));

    // scope filters on the project's share visibility.
    if (scope === "personal") {
      candidates = candidates.filter((c) => c.project.visibility === null);
    } else if (scope === "team") {
      candidates = candidates.filter((c) => c.project.visibility === "team");
    } else if (scope === "org") {
      candidates = candidates.filter(
        (c) => c.project.visibility === "organization",
      );
    } else {
      // "All": show only what the caller can actually access — own, org-shared,
      // and team-shared to a team they belong to. For an admin that drops every
      // oversight row (other members' private projects AND team-shared projects
      // for teams they aren't in); those stay reachable via Personal → Other
      // users and Team → pick that team. Non-admins have no oversight candidates
      // to begin with, so this is a no-op for them.
      candidates = candidates.filter((c) => c.viewerRole !== "admin");
    }

    // admin "My / Other users" owner sub-filter (honored upstream for admins only).
    if (params.authorIds?.length) {
      const include = new Set(params.authorIds);
      candidates = candidates.filter((c) => include.has(c.project.userId));
    }
    if (params.excludeAuthorIds?.length) {
      const exclude = new Set(params.excludeAuthorIds);
      candidates = candidates.filter((c) => !exclude.has(c.project.userId));
    }

    // Pure name/description search — applied before the share-teams fetch so
    // the DB query below only covers the surviving candidates.
    const query = params.search?.trim().toLowerCase();
    if (query) {
      candidates = candidates.filter(
        ({ project }) =>
          project.name.toLowerCase().includes(query) ||
          (project.description?.toLowerCase().includes(query) ?? false),
      );
    }

    // Team memberships for team-shared projects — backs both the `teamIds`
    // filter and the owner's team-name visibility badge. Fetched once, only when
    // team data is actually relevant.
    const needTeams =
      !!params.teamIds?.length ||
      candidates.some((c) => c.project.visibility === "team");
    const shareTeams = needTeams
      ? await ProjectShareModel.getShareTeamsForProjects(
          candidates.map((c) => c.project.id),
        )
      : new Map<string, { id: string; name: string }[]>();

    // teamIds narrows scope=team to projects shared with any chosen team.
    if (params.teamIds?.length) {
      const want = new Set(params.teamIds);
      candidates = candidates.filter((c) =>
        (shareTeams.get(c.project.id) ?? []).some((t) => want.has(t.id)),
      );
    }

    // owner-first then newest — a stable order under the frontend's pinned grouping.
    candidates.sort((a, b) => {
      const aOwn = a.viewerRole === "owner" ? 0 : 1;
      const bOwn = b.viewerRole === "owner" ? 0 : 1;
      if (aOwn !== bOwn) return aOwn - bOwn;
      return b.project.createdAt.getTime() - a.project.createdAt.getTime();
    });

    const projectIds = candidates.map((c) => c.project.id);
    const ownerIds = [...new Set(candidates.map((c) => c.project.userId))];
    const [counts, pins, ownerNames] = await Promise.all([
      ProjectModel.countConversations(projectIds),
      ProjectPinModel.getPinnedAtForProjects({ userId, projectIds }),
      UserModel.getNamesByIds(ownerIds),
    ]);
    return candidates.map(({ project, viewerRole }) => ({
      id: project.id,
      name: project.name,
      description: project.description,
      icon: project.icon,
      viewerRole,
      ownerName: ownerNames.get(project.userId) ?? null,
      conversationCount: counts.get(project.id) ?? 0,
      visibility: project.visibility,
      // Team-shared projects expose their team names for the badge to the
      // owner and to a project:admin overseeing them. A plain "shared"
      // recipient (a member of one of the teams) gets null — the full target
      // list stays the owner's business. Non-team projects: null.
      shareTeamNames:
        (viewerRole === "owner" || viewerRole === "admin") &&
        project.visibility === "team"
          ? (shareTeams.get(project.id) ?? []).map((t) => t.name)
          : null,
      pinnedAt: pins.get(project.id) ?? null,
      createdAt: project.createdAt,
    }));
  }

  async get(params: {
    id: string;
    organizationId: string;
    userId: string;
    allowAdminOversight?: boolean;
  }): Promise<ProjectDetail> {
    const { project, viewerRole } = await this.requireViewable(params);
    const [share, counts, pins, ownerNames, shareTeams] = await Promise.all([
      ProjectShareModel.findByProjectId(project.id),
      ProjectModel.countConversations([project.id]),
      ProjectPinModel.getPinnedAtForProjects({
        userId: params.userId,
        projectIds: [project.id],
      }),
      UserModel.getNamesByIds([project.userId]),
      ProjectShareModel.getShareTeamsForProjects([project.id]),
    ]);
    // Share targets are visible to whoever can manage the project (so the edit
    // dialog can populate sharing): the owner, or a project admin — including on
    // a project merely shared with them (viewerRole "shared"), so they still get
    // the team list. requireManageable enforces the same gate on write.
    const canManage =
      viewerRole === "owner" ||
      viewerRole === "admin" ||
      (await userHasPermission(
        params.userId,
        params.organizationId,
        "project",
        "admin",
      ));
    return {
      id: project.id,
      name: project.name,
      description: project.description,
      icon: project.icon,
      viewerRole,
      ownerName: ownerNames.get(project.userId) ?? null,
      conversationCount: counts.get(project.id) ?? 0,
      visibility: share?.visibility ?? null,
      shareTeamIds: canManage ? (share?.teamIds ?? []) : null,
      shareTeamNames:
        viewerRole === "owner" && share?.visibility === "team"
          ? (shareTeams.get(project.id) ?? []).map((t) => t.name)
          : null,
      pinnedAt: pins.get(project.id) ?? null,
      createdAt: project.createdAt,
    };
  }

  /** Update name/description/icon (owner or project admin); only provided keys change. */
  async update(params: {
    id: string;
    organizationId: string;
    userId: string;
    name?: string;
    description?: string | null;
    icon?: string | null;
  }): Promise<void> {
    await this.requireManageable(params);
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
    // Instructions are project config (not chats), so a project admin overseeing
    // a foreign project may read them too — same gate as the project detail/files.
    const { project } = await this.requireViewable({
      ...params,
      allowAdminOversight: true,
    });
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
    // Writing instructions is project management (like edit/share/delete), so the
    // owner or a project admin may do it.
    const project = await this.requireManageable(params);
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
    await this.requireManageable(params);
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
    await this.requireManageable(params);
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
    allowAdminOversight?: boolean;
  }): Promise<SandboxFileListItem[]> {
    const { project } = await this.requireViewable(params);
    // Access is the service gate above (requireViewable); fileStore.search
    // lists by project scope and does not re-check the caller.
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

  /**
   * Upload one file into the project (drag-and-drop on the Files panel).
   *
   * Authorized by project membership (owner/share) via `requireReadable` — NOT
   * `requireViewable`, whose admin oversight is read-only. This is a write, but
   * project files are member-level state (any member already produces them via
   * sandbox runs), so it is not owner-gated like the project's own metadata.
   *
   * The bytes arrive base64-encoded in the JSON body; the decoded size is capped
   * at {@link MAX_PROJECT_UPLOAD_BYTES}. On a name collision the file is
   * auto-renamed (`report.pdf` -> `report (1).pdf`) up to a bounded number of
   * attempts before giving up — covering both the unique index and the object
   * store's exclusive write, including concurrent same-name uploads.
   */
  async uploadFile(params: {
    id: string;
    organizationId: string;
    userId: string;
    name: string;
    mimeType: string;
    dataBase64: string;
  }): Promise<{ id: string; filename: string; mimeType: string }> {
    const project = await this.requireReadable(params);
    const data = decodeUploadBase64(params.dataBase64);
    if (data.byteLength > MAX_PROJECT_UPLOAD_BYTES) {
      throw new ApiError(
        413,
        `File is too large (max ${MAX_PROJECT_UPLOAD_MB} MB)`,
      );
    }
    const filename = sanitizeUploadFilename(params.name);
    // The instructions file steers every chat in the project and is owner-only
    // via setInstructions (with its own length cap); an upload must not be able
    // to create or replace it, bypassing that gate. Compared case-insensitively
    // so a case variant can't impersonate it (or collide on a case-insensitive
    // filesystem store).
    if (filename.toLowerCase() === PROJECT_INSTRUCTIONS_FILENAME) {
      throw new ApiError(
        400,
        `"${PROJECT_INSTRUCTIONS_FILENAME}" is reserved; edit the project instructions instead`,
      );
    }
    const mimeType = params.mimeType.trim() || "application/octet-stream";

    for (let attempt = 0; attempt <= MAX_UPLOAD_RENAME_ATTEMPTS; attempt++) {
      const candidate =
        attempt === 0 ? filename : nextAvailableName(filename, attempt);
      try {
        const file = await fileStore.put({
          organizationId: params.organizationId,
          userId: params.userId,
          projectId: project.id,
          conversationId: null,
          filename: candidate,
          mimeType,
          sizeBytes: data.byteLength,
          data,
        });
        return {
          id: file.id,
          filename: file.filename,
          mimeType: file.mimeType,
        };
      } catch (error) {
        if (error instanceof FileNameExistsError) continue;
        throw error;
      }
    }
    throw new ApiError(
      409,
      `Could not find an available name for "${filename}"`,
    );
  }

  async listConversations(params: {
    id: string;
    organizationId: string;
    userId: string;
  }): Promise<ProjectConversationItem[]> {
    // Chats are NOT part of admin oversight — this stays share/owner-only, so a
    // `project:admin` viewing a foreign project cannot list (or open) its chats.
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

  /**
   * Project the caller may read, with their relationship to it. Share/owner
   * access always counts; a `project:admin` caller also passes when
   * `allowAdminOversight` is set (read-only oversight of a foreign project).
   * "no access" reads as 404.
   */
  private async requireViewable(params: {
    id: string;
    organizationId: string;
    userId: string;
    allowAdminOversight?: boolean;
  }): Promise<{ project: Project; viewerRole: ProjectViewerRole }> {
    const project = await ProjectModel.findById(params.id);
    if (project && project.organizationId === params.organizationId) {
      if (project.userId === params.userId) {
        return { project, viewerRole: "owner" };
      }
      if (
        await ProjectShareModel.userCanAccessProject({
          project,
          userId: params.userId,
          organizationId: params.organizationId,
        })
      ) {
        return { project, viewerRole: "shared" };
      }
      if (
        params.allowAdminOversight &&
        (await this.callerIsProjectAdmin(params))
      ) {
        return { project, viewerRole: "admin" };
      }
    }
    throw new ApiError(404, "Project not found");
  }

  /**
   * Project the caller may manage (edit/share/delete), by id: the owner, or a
   * `project:admin` for any project in the org. "not allowed" reads as 404.
   */
  private async requireManageable(params: {
    id: string;
    organizationId: string;
    userId: string;
  }): Promise<Project> {
    const owned = await ProjectModel.findByIdForOwner({
      id: params.id,
      userId: params.userId,
      organizationId: params.organizationId,
    });
    if (owned) return owned;
    const project = await ProjectModel.findById(params.id);
    if (
      project &&
      project.organizationId === params.organizationId &&
      (await this.callerIsProjectAdmin(params))
    ) {
      return project;
    }
    throw new ApiError(404, "Project not found");
  }

  private async callerIsProjectAdmin(params: {
    organizationId: string;
    userId: string;
  }): Promise<boolean> {
    return userHasPermission(
      params.userId,
      params.organizationId,
      "project",
      "admin",
    );
  }
}

export const projectService = new ProjectService();

// Bounded so a pathological collision (or a hostile client racing the same name)
// can't spin forever; 50 distinct " (n)" candidates is far beyond any real case.
const MAX_UPLOAD_RENAME_ATTEMPTS = 50;

/**
 * Decode an upload's base64 body to bytes. Tolerates an accidental `data:` URL
 * prefix and rejects a payload that is empty or not valid base64 (Buffer.from is
 * lenient and would otherwise silently drop garbage), so callers get a clean 400.
 */
function decodeUploadBase64(input: string): Buffer {
  const commaIdx = input.startsWith("data:") ? input.indexOf(",") : -1;
  const payload = commaIdx >= 0 ? input.slice(commaIdx + 1) : input;
  const normalized = payload.replace(/\s/g, "");
  if (normalized.length === 0) {
    throw new ApiError(400, "File is empty");
  }
  // A base64 length of n % 4 === 1 can't encode whole bytes; Buffer.from would
  // silently drop the dangling char instead of erroring, so reject it here.
  if (
    !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) ||
    normalized.length % 4 === 1
  ) {
    throw new ApiError(400, "File data is not valid base64");
  }
  const data = Buffer.from(normalized, "base64");
  if (data.byteLength === 0) {
    throw new ApiError(400, "File is empty");
  }
  return data;
}
