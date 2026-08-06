import {
  MAX_PROJECT_UPLOAD_BYTES,
  MAX_PROJECT_UPLOAD_MB,
  PROJECT_INSTRUCTIONS_FILENAME,
} from "@archestra/shared";
import { sql } from "drizzle-orm";
import { isGlobalAdmin, userHasPermission } from "@/auth";
import { withDbTransaction } from "@/database";
import logger from "@/logging";
import {
  AgentModel,
  AgentTeamModel,
  ConversationModel,
  ConversationNotOwnedError,
  FileNameExistsError,
  ProjectAlreadyAssignedError,
  ProjectModel,
  ProjectNameExistsError,
  ProjectPinModel,
  ProjectShareModel,
  TeamModel,
  UserModel,
} from "@/models";
import { fileStore } from "@/skills-sandbox/file-store";
import { validateProjectName } from "@/skills-sandbox/project-name";
import type {
  AgentScope,
  Project,
  ProjectConversationItem,
  ProjectDetail,
  ProjectLifecycle,
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

/** Who a project reaches, which is what its default agent must cover. */
type ProjectShareAudience = {
  visibility: ProjectShareVisibility | null;
  teamIds: string[];
  userIds: string[];
};

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
    defaultAgentId?: string | null;
  }): Promise<Project> {
    const name = params.name.trim();
    const invalid = validateProjectName(name);
    if (invalid) {
      throw new ApiError(400, `project name is invalid: ${invalid}`);
    }
    if (params.defaultAgentId) {
      // A project is unshared at creation, so the creator is its whole audience.
      await this.requirePinnableDefaultAgent({
        agentId: params.defaultAgentId,
        organizationId: params.organizationId,
        ownerUserId: params.userId,
        share: { visibility: null, teamIds: [], userIds: [] },
      });
    }
    try {
      return await ProjectModel.create({
        organizationId: params.organizationId,
        userId: params.userId,
        name,
        description: params.description,
        icon: params.icon ?? null,
        defaultAgentId: params.defaultAgentId ?? null,
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
    status?: ProjectLifecycle;
  }): Promise<ProjectListItem[]> {
    const { organizationId, userId, scope } = params;

    // The deleted slice is a separate, project:admin-only oversight path; the
    // active browse pipeline below (scope/author/search/team filters, the
    // "All" branch that drops admin-oversight rows) does not apply to it.
    if (params.status === "deleted") {
      return this.listDeleted({
        organizationId,
        userId,
        isProjectAdmin: params.isProjectAdmin,
      });
    }

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
    const [counts, pins, ownerNames, shareUsers] = await Promise.all([
      ProjectModel.countConversations(projectIds),
      ProjectPinModel.getPinnedAtForProjects({ userId, projectIds }),
      UserModel.getNamesByIds(ownerIds),
      ProjectShareModel.getShareUsersForProjects(projectIds),
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
      // Same gate as shareTeamNames: without these a project shared with named
      // people renders as private, which is the opposite of what happened.
      shareUserNames:
        (viewerRole === "owner" || viewerRole === "admin") &&
        project.visibility === "user"
          ? (shareUsers.get(project.id) ?? []).map((u) => u.name)
          : null,
      pinnedAt: pins.get(project.id) ?? null,
      createdAt: project.createdAt,
      // Active slice: soft-deleted rows are filtered out upstream, so this is
      // always null here. Non-null rows only surface via listDeleted.
      deletedAt: project.deletedAt,
    }));
  }

  /**
   * Org-wide list of soft-deleted projects for a `project:admin` — the oversight
   * companion to {@link restore}. Non-admins get nothing. Every row is
   * `viewerRole: "admin"` (a soft-deleted project is never in anyone's
   * accessible set) and carries `deletedAt` for the "deleted N ago" label.
   * `conversationCount` is typically 0: chats detached on delete.
   */
  private async listDeleted(params: {
    organizationId: string;
    userId: string;
    isProjectAdmin?: boolean;
  }): Promise<ProjectListItem[]> {
    if (!params.isProjectAdmin) return [];
    const deleted = await ProjectShareModel.listAllOrgProjects({
      organizationId: params.organizationId,
      lifecycle: "deleted",
    });
    const projectIds = deleted.map((p) => p.id);
    const ownerIds = [...new Set(deleted.map((p) => p.userId))];
    const [counts, pins, ownerNames, shareTeams, shareUsers] =
      await Promise.all([
        ProjectModel.countConversations(projectIds),
        ProjectPinModel.getPinnedAtForProjects({
          userId: params.userId,
          projectIds,
        }),
        UserModel.getNamesByIds(ownerIds),
        ProjectShareModel.getShareTeamsForProjects(projectIds),
        ProjectShareModel.getShareUsersForProjects(projectIds),
      ]);
    return deleted.map((project) => ({
      id: project.id,
      name: project.name,
      description: project.description,
      icon: project.icon,
      viewerRole: "admin" as ProjectViewerRole,
      ownerName: ownerNames.get(project.userId) ?? null,
      conversationCount: counts.get(project.id) ?? 0,
      visibility: project.visibility,
      shareTeamNames:
        project.visibility === "team"
          ? (shareTeams.get(project.id) ?? []).map((t) => t.name)
          : null,
      shareUserNames:
        project.visibility === "user"
          ? (shareUsers.get(project.id) ?? []).map((u) => u.name)
          : null,
      pinnedAt: pins.get(project.id) ?? null,
      createdAt: project.createdAt,
      deletedAt: project.deletedAt,
    }));
  }

  async get(params: {
    id: string;
    organizationId: string;
    userId: string;
    allowAdminOversight?: boolean;
  }): Promise<ProjectDetail> {
    const { project, viewerRole } = await this.requireViewable(params);
    const [
      share,
      counts,
      pins,
      ownerNames,
      shareTeams,
      shareUsers,
      defaultAgent,
    ] = await Promise.all([
      ProjectShareModel.findByProjectId(project.id),
      ProjectModel.countConversations([project.id]),
      ProjectPinModel.getPinnedAtForProjects({
        userId: params.userId,
        projectIds: [project.id],
      }),
      UserModel.getNamesByIds([project.userId]),
      ProjectShareModel.getShareTeamsForProjects([project.id]),
      ProjectShareModel.getShareUsersForProjects([project.id]),
      project.defaultAgentId
        ? AgentModel.findPinnableProjectDefault({
            id: project.defaultAgentId,
            organizationId: project.organizationId,
          })
        : null,
    ]);
    // Re-checked rather than returned raw: a pin can outlive its eligibility —
    // the agent soft-deleted, rescoped, or the project shared more widely than
    // the agent reaches — and reporting a stale one would preselect an agent
    // the member cannot actually use.
    const reachableDefaultAgent =
      defaultAgent &&
      (await this.agentReachesAudience({
        agent: defaultAgent,
        ownerUserId: project.userId,
        share: {
          visibility: share?.visibility ?? null,
          teamIds: share?.teamIds ?? [],
          userIds: share?.userIds ?? [],
        },
      }))
        ? { id: defaultAgent.id, name: defaultAgent.name }
        : null;
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
      shareUserIds: canManage ? (share?.userIds ?? []) : null,
      shareTeamNames:
        viewerRole === "owner" && share?.visibility === "team"
          ? (shareTeams.get(project.id) ?? []).map((t) => t.name)
          : null,
      shareUserNames:
        canManage && share?.visibility === "user"
          ? (shareUsers.get(project.id) ?? []).map((u) => u.name)
          : null,
      pinnedAt: pins.get(project.id) ?? null,
      defaultAgent: reachableDefaultAgent,
      createdAt: project.createdAt,
      deletedAt: project.deletedAt,
    };
  }

  /**
   * Update name/description/icon/default agent (owner or project admin); only
   * provided keys change.
   */
  async update(params: {
    id: string;
    organizationId: string;
    userId: string;
    name?: string;
    description?: string | null;
    icon?: string | null;
    defaultAgentId?: string | null;
  }): Promise<void> {
    const project = await this.requireManageable(params);
    const fields: {
      name?: string;
      description?: string | null;
      icon?: string | null;
      defaultAgentId?: string | null;
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
    if (params.defaultAgentId !== undefined) {
      if (params.defaultAgentId !== null) {
        await this.requirePinnableDefaultAgent({
          agentId: params.defaultAgentId,
          organizationId: params.organizationId,
          ownerUserId: project.userId,
          share: await this.loadShareAudience(params.id),
        });
      }
      fields.defaultAgentId = params.defaultAgentId;
    } else if (project.defaultAgentId) {
      // Repair a pin that outlived its eligibility. The read path hides such a
      // pin, so the editor is shown "no default" and cannot clear what it
      // cannot see — leaving the row set means re-widening the agent's scope
      // silently resurrects a pin the user was last told was absent.
      const stillReachable = await this.agentReachesProjectAudience({
        agentId: project.defaultAgentId,
        organizationId: params.organizationId,
        ownerUserId: project.userId,
        share: await this.loadShareAudience(params.id),
      });
      if (!stillReachable) fields.defaultAgentId = null;
    }
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
    userIds?: string[];
  }): Promise<void> {
    const project = await this.requireManageable(params);
    // Org-wide visibility is a broadcast to the whole organization, so both
    // entering and leaving it are gated behind `project:share-org` — otherwise
    // any owner could publish to (or silently withdraw from) everyone.
    const share = await ProjectShareModel.findByProjectId(params.id);
    if (
      (params.visibility === "organization" ||
        share?.visibility === "organization") &&
      !(await this.callerCanShareOrg(params))
    ) {
      throw new ApiError(
        403,
        "You don't have permission to manage organization-wide project sharing",
      );
    }
    if (params.visibility === null) {
      await ProjectShareModel.remove(params.id);
      // Unsharing only ever narrows the audience, so a pin that was reachable
      // before still is.
      return;
    }
    if (params.visibility === "team") {
      await this.assertShareTeams(params);
    }
    await ProjectShareModel.upsert({
      projectId: params.id,
      organizationId: params.organizationId,
      createdByUserId: params.userId,
      visibility: params.visibility,
      teamIds: params.teamIds,
      userIds: params.userIds ?? [],
    });
    await this.clearDefaultAgentBeyondAudience({
      project,
      share: {
        visibility: params.visibility,
        teamIds: params.teamIds,
        userIds: params.userIds ?? [],
      },
    });
  }

  /**
   * Widening a project's sharing can outgrow its pinned agent. Drop the pin
   * rather than leave a row pointing at an agent the new audience cannot run —
   * the read path would hide it anyway, and a stale row resurfaces if the
   * project is later narrowed again.
   */
  private async clearDefaultAgentBeyondAudience(params: {
    project: Project;
    share: ProjectShareAudience;
  }): Promise<void> {
    if (!params.project.defaultAgentId) return;
    const stillReachable = await this.agentReachesProjectAudience({
      agentId: params.project.defaultAgentId,
      organizationId: params.project.organizationId,
      ownerUserId: params.project.userId,
      share: params.share,
    });
    if (stillReachable) return;
    await ProjectModel.update({
      id: params.project.id,
      fields: { defaultAgentId: null },
    });
  }

  /**
   * Soft delete via {@link ProjectModel.delete}: the project row is stamped
   * `deleted_at` and its files + scheduled tasks are RETAINED but hidden, so a
   * restore recovers them intact. Only chats detach (SET NULL) and survive as
   * ordinary conversations. Nothing is purged — externally-stored bytes are
   * kept in place (the object folder is the project's slug, which the retained
   * row keeps), reclaimed only by a future hard-delete/purge path.
   */
  async delete(params: {
    id: string;
    organizationId: string;
    userId: string;
  }): Promise<void> {
    await this.requireManageable(params);
    // An org-wide project is a shared resource: deleting it takes it away from
    // the whole organization, so it is gated behind `project:share-org` just
    // like changing the org share (which also blocks the unshare-then-delete
    // workaround).
    const share = await ProjectShareModel.findByProjectId(params.id);
    if (
      share?.visibility === "organization" &&
      !(await this.callerCanShareOrg(params))
    ) {
      throw new ApiError(
        403,
        "You don't have permission to delete an organization-wide project",
      );
    }
    await ProjectModel.delete(params.id);
  }

  /**
   * Restore a soft-deleted project — an admin-only oversight action, the inverse
   * of {@link delete}. Its retained files and scheduled tasks come back with it;
   * chats do NOT (they detached on delete), so a restored project reports zero
   * chats.
   *
   * Admin-only by design: restore and the deleted-projects view are one
   * `project:admin` capability. The owner branch is deliberately absent — an
   * owner who cannot even see their deleted projects should not restore one by
   * id. Unknown / already-active / wrong-org ids read as 404; an org-wide share
   * needs `project:share-org` (as delete does).
   *
   * Deleting frees the display name (the `(user_id, name)` index is partial on
   * `deleted_at IS NULL`), so the owner may hold an active project under that
   * name by the time anyone restores. `name` is the way out: it renames the
   * project on the way back, in the same transaction, so the collision is
   * recoverable without touching whichever project took the name. Restoring
   * into a name that is still taken — with or without `name` — is a 409 that
   * says so.
   */
  async restore(params: {
    id: string;
    organizationId: string;
    userId: string;
    /** Rename on restore; the remedy when the original name was re-taken. */
    name?: string;
  }): Promise<ProjectDetail> {
    if (!(await this.callerIsProjectAdmin(params))) {
      throw new ApiError(404, "Project not found");
    }
    const project = await ProjectModel.findDeletedByIdForOrganization({
      id: params.id,
      organizationId: params.organizationId,
    });
    if (!project) {
      throw new ApiError(404, "Project not found");
    }
    const share = await ProjectShareModel.findByProjectId(params.id);
    if (
      share?.visibility === "organization" &&
      !(await this.callerCanShareOrg(params))
    ) {
      throw new ApiError(
        403,
        "You don't have permission to restore an organization-wide project",
      );
    }
    let newName: string | undefined;
    if (params.name !== undefined) {
      newName = params.name.trim();
      const invalid = validateProjectName(newName);
      if (invalid) {
        throw new ApiError(400, `project name is invalid: ${invalid}`);
      }
    }
    let restored: boolean;
    try {
      restored = await ProjectModel.restore({
        id: params.id,
        organizationId: params.organizationId,
        name: project.name,
        newName,
      });
    } catch (error) {
      if (error instanceof ProjectNameExistsError) {
        throw new ApiError(
          409,
          `cannot restore: its owner already has an active project named "${newName ?? project.name}". ` +
            "Restore it under a different name by passing `name`.",
        );
      }
      throw error;
    }
    // Lost a race: another request restored or hard-deleted it first.
    if (!restored) {
      throw new ApiError(404, "Project not found");
    }
    // Now active again; the caller is a project:admin (checked above) but not
    // necessarily an owner/share recipient, so read it back via admin oversight.
    return this.get({ ...params, allowAdminOversight: true });
  }

  /**
   * Permanently destroy a soft-deleted project. Irreversible, no grace period:
   * the row goes, and the cascade takes its files, pins, share configuration,
   * and scheduled tasks (with their runs). Chats are untouched — they detached
   * at soft-delete time and survive as ordinary conversations.
   *
   * Global admins only, checked before anything is read. Unknown ids, live
   * projects, other tenants' projects, and callers who are not global admins
   * all read as the same 404: a distinct error on any of them would confirm
   * that a trashed project with that id exists.
   *
   * `project:admin` deliberately does NOT reach here. It is the oversight grant
   * — see, restore, tidy up after other members — and a custom role can carry
   * it without holding {@link delete}'s `project:share-org` gate on org-wide
   * projects. Destroying a project outright is the deployment owner's call, so
   * the built-in admin roles are the whole gate and the share-org branch has
   * nothing left to protect.
   *
   * File BYTES living outside Postgres are removed by row, INSIDE the
   * transaction and as its last step. Two things follow from that, both
   * deliberate:
   *
   * The conversation equivalent (`fileStore.purgeConversationFileRows`, as used
   * by the retention job) defers its byte deletion to AFTER commit, and that is
   * right there — a conversation's object key contains a UUID, which is never
   * handed out twice. A project's key contains its SLUG, and committing this
   * delete frees that slug for the next project of the same name
   * ({@link ProjectModel.generateUniqueSlug} counts only existing rows). Delete
   * after commit and a project created in that window owns these paths while
   * they are still being removed. Deleting before commit keeps the row — and so
   * the slug — held, which closes it.
   *
   * Byte deletion goes LAST because an object store cannot roll back. Anything
   * that fails ahead of it (the lock, the cascade, a deadlock between them)
   * rolls back for free; only a commit failure, the one step after, can leave a
   * restored project whose bytes are gone.
   *
   * Nothing bounds the object-store round-trips, so the transaction is capped
   * by `idle_in_transaction_session_timeout` — `statement_timeout` does not
   * cover time spent between statements. Hitting the cap aborts the purge and
   * leaves the project in the trash, possibly minus some bytes.
   *
   * Objects sitting in the project's folder with no `files` row are NOT
   * removed; nothing attributes them to a project. See
   * {@link FileStore.captureProjectFileBytes}.
   *
   * An object the store refuses to delete does not fail the purge — the rows
   * are gone by then, so the only alternative is a project that can never be
   * purged. It is reported instead: each one warns with its object key and
   * increments `file_storage_orphaned_objects_total`, and a surviving count
   * warns once more here. Alert on the counter; a "permanent" delete that left
   * bytes behind is not something to discover by reading logs.
   */
  async purge(params: {
    id: string;
    organizationId: string;
    userId: string;
  }): Promise<void> {
    if (!(await isGlobalAdmin(params.userId, params.organizationId))) {
      throw new ApiError(404, "Project not found");
    }

    const purged = await withDbTransaction(async (tx) => {
      // `sql.raw`, not an interpolated value: SET is a utility command and
      // takes no bind parameters. The value is a module constant.
      await tx.execute(
        sql.raw(
          `SET LOCAL idle_in_transaction_session_timeout = ${PURGE_IDLE_TIMEOUT_MS}`,
        ),
      );

      // The lock is the race guard: a concurrent restore either wins (no
      // soft-deleted row here, so we stop) or waits and then finds nothing.
      const locked = await ProjectModel.lockIfDeleted(tx, {
        id: params.id,
        organizationId: params.organizationId,
      });
      if (!locked) return false;

      // Captured while the rows still exist — the cascade below removes them.
      const purgeBytes = await fileStore.captureProjectFileBytes(
        { organizationId: params.organizationId, projectId: params.id },
        tx,
      );
      await ProjectModel.hardDeleteLocked(tx, params.id);
      return { orphaned: await purgeBytes() };
    });

    if (!purged) throw new ApiError(404, "Project not found");

    // A byte delete that fails does NOT fail the purge: the rows are already
    // gone, so refusing to commit would only trade leftover bytes for a project
    // that cannot be purged at all. It must not pass silently either — this is
    // the one line that says a "permanent" delete was not total, and it names a
    // count so a store-wide outage reads differently from one stubborn object.
    if (purged.orphaned > 0) {
      logger.warn(
        {
          projectId: params.id,
          organizationId: params.organizationId,
          orphaned: purged.orphaned,
        },
        "Project permanently deleted, but some stored file contents could not be removed and are now orphaned; see the preceding warnings for their object keys",
      );
    }
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
    // Reading another member's chats requires `project:read-all` — uniformly,
    // including in a project the caller owns. Without it, callers see only the
    // chats they authored. `project:admin` does NOT grant this (chats are not
    // part of admin oversight), so a `project:admin` viewing a foreign project
    // still cannot list its chats (requireReadable already excludes them).
    const project = await this.requireReadable(params);
    const canReadAllChats = await this.callerCanReadAllChats(params);
    // Without `project:read-all`, scope the query to the caller's own chats in
    // SQL rather than fetching every project chat and filtering in memory.
    const rows = await ProjectModel.listConversations(
      project.id,
      canReadAllChats ? undefined : params.userId,
    );
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

  /**
   * A project's default agent must be one every member of the project can
   * actually use, however widely the project is shared. Org scope is what
   * guarantees that, so it is enforced here rather than left to the picker.
   */
  private async requirePinnableDefaultAgent(params: {
    agentId: string;
    organizationId: string;
    ownerUserId: string;
    share: ProjectShareAudience;
  }): Promise<void> {
    if (
      !(await this.agentReachesProjectAudience({
        agentId: params.agentId,
        organizationId: params.organizationId,
        ownerUserId: params.ownerUserId,
        share: params.share,
      }))
    ) {
      throw new ApiError(
        400,
        "A project's default agent must be usable by everyone the project is shared with",
      );
    }
  }

  /**
   * Whether every person the project reaches can actually run the agent. A pin
   * nobody but the owner can see would silently drop those members back to the
   * organization default, so eligibility is a function of the project's sharing
   * rather than a fixed scope.
   *
   * An `org` agent always qualifies. Otherwise the audience decides: a team
   * share needs a team agent covering every shared team, while a private or
   * named-user share is small enough to check person by person.
   */
  private async agentReachesProjectAudience(params: {
    agentId: string;
    organizationId: string;
    ownerUserId: string;
    share: ProjectShareAudience;
  }): Promise<boolean> {
    const agent = await AgentModel.findPinnableProjectDefault({
      id: params.agentId,
      organizationId: params.organizationId,
    });
    if (!agent) return false;
    return this.agentReachesAudience({
      agent,
      ownerUserId: params.ownerUserId,
      share: params.share,
    });
  }

  private async agentReachesAudience(params: {
    agent: { id: string; scope: AgentScope };
    ownerUserId: string;
    share: ProjectShareAudience;
  }): Promise<boolean> {
    const { agent } = params;
    if (agent.scope === "org") return true;

    switch (params.share.visibility) {
      // Nothing narrower than an `org` agent covers the whole organization.
      case "organization":
        return false;
      case "team": {
        if (agent.scope !== "team") return false;
        const agentTeamIds = new Set(
          await AgentTeamModel.getTeamsForAgent(agent.id),
        );
        const coversSharedTeams = params.share.teamIds.every((teamId) =>
          agentTeamIds.has(teamId),
        );
        // The owner chats here too and may not belong to the teams the project
        // is shared with. Leaving them out would accept a pin they cannot run,
        // which unsharing would then have to take away again.
        return (
          coversSharedTeams &&
          (await this.everyUserHasAgentAccess([params.ownerUserId], agent.id))
        );
      }
      case "user":
        return this.everyUserHasAgentAccess(
          [params.ownerUserId, ...params.share.userIds],
          agent.id,
        );
      // Unshared: the owner is the only person who ever starts a chat here.
      default:
        return this.everyUserHasAgentAccess([params.ownerUserId], agent.id);
    }
  }

  private async everyUserHasAgentAccess(
    userIds: string[],
    agentId: string,
  ): Promise<boolean> {
    const checks = await Promise.all(
      [...new Set(userIds)].map((userId) =>
        AgentTeamModel.userHasAgentAccess(userId, agentId, false),
      ),
    );
    return checks.every(Boolean);
  }

  /** The project's current sharing, as the pin-eligibility rule reads it. */
  private async loadShareAudience(
    projectId: string,
  ): Promise<ProjectShareAudience> {
    const share = await ProjectShareModel.findByProjectId(projectId);
    return {
      visibility: share?.visibility ?? null,
      teamIds: share?.teamIds ?? [],
      userIds: share?.userIds ?? [],
    };
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

  /**
   * Validate the teams a project is being shared with. A team share needs at
   * least one team (otherwise it reaches nobody), every team must exist within
   * the caller's organization — a stale, bogus, or foreign-org id fails with a
   * clean 400 instead of an FK violation mid-write — and a caller without
   * `project:admin` may only share with teams they belong to. A `project:admin`
   * may share with any team in the organization, which is how a project is set
   * up on a team's behalf. Mirrors the agent, skill, and catalog write paths.
   */
  private async assertShareTeams(params: {
    teamIds: string[];
    organizationId: string;
    userId: string;
  }): Promise<void> {
    if (params.teamIds.length === 0) {
      throw new ApiError(
        400,
        "A team-shared project must be shared with at least one team",
      );
    }

    const teams = await TeamModel.findByIds(params.teamIds);
    const validIds = new Set(
      teams
        .filter((team) => team.organizationId === params.organizationId)
        .map((team) => team.id),
    );
    const missing = params.teamIds.filter((id) => !validIds.has(id));
    if (missing.length > 0) {
      throw new ApiError(400, `Unknown team id(s): ${missing.join(", ")}`);
    }

    if (await this.callerIsProjectAdmin(params)) return;

    const userTeamIds = new Set(await TeamModel.getUserTeamIds(params.userId));
    const invalid = params.teamIds.filter((id) => !userTeamIds.has(id));
    if (invalid.length > 0) {
      throw new ApiError(
        403,
        "You can only share projects with teams you are a member of",
      );
    }
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

  private async callerCanShareOrg(params: {
    organizationId: string;
    userId: string;
  }): Promise<boolean> {
    return userHasPermission(
      params.userId,
      params.organizationId,
      "project",
      "share-org",
    );
  }

  private async callerCanReadAllChats(params: {
    organizationId: string;
    userId: string;
  }): Promise<boolean> {
    return userHasPermission(
      params.userId,
      params.organizationId,
      "project",
      "read-all",
    );
  }
}

export const projectService = new ProjectService();

// Bounded so a pathological collision (or a hostile client racing the same name)
// can't spin forever; 50 distinct " (n)" candidates is far beyond any real case.
const MAX_UPLOAD_RENAME_ATTEMPTS = 50;

/**
 * Ceiling for {@link ProjectService.purge}'s transaction. Its object-store
 * deletes run between statements, where `statement_timeout` does not reach, so
 * without this a slow store could hold the transaction — and a pool connection,
 * and vacuum — open indefinitely. Generous rather than tight: hitting it aborts
 * a purge that was already partway through deleting bytes.
 */
const PURGE_IDLE_TIMEOUT_MS = 300_000;

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
