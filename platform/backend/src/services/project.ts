import { userHasPermission } from "@/auth";
import ProjectModel from "@/models/project";
import TeamModel from "@/models/team";
import type {
  InsertProject,
  Project,
  ProjectScope,
  UpdateProject,
} from "@/types";
import { ApiError } from "@/types";

export async function listProjects(params: {
  organizationId: string;
  userId: string;
  limit: number;
  offset: number;
  search?: string;
  scope?: ProjectScope;
}) {
  const isProjectAdmin = await userHasPermission(
    params.userId,
    params.organizationId,
    "project",
    "admin",
  );

  return ProjectModel.findByOrganization({
    ...params,
    isProjectAdmin,
  });
}

export async function getProject(params: {
  id: string;
  organizationId: string;
  userId: string;
}): Promise<Project> {
  const isProjectAdmin = await userHasPermission(
    params.userId,
    params.organizationId,
    "project",
    "admin",
  );
  const canAccess = await ProjectModel.userCanAccessProject({
    projectId: params.id,
    organizationId: params.organizationId,
    userId: params.userId,
    isProjectAdmin,
  });
  if (!canAccess) {
    throw new ApiError(404, "Project not found");
  }

  const project = await ProjectModel.findDetailById({
    id: params.id,
    organizationId: params.organizationId,
  });
  if (!project) {
    throw new ApiError(404, "Project not found");
  }

  return project;
}

export async function createProject(params: {
  organizationId: string;
  userId: string;
  data: InsertProject;
}): Promise<Project> {
  const scope = params.data.scope ?? "personal";
  await validateProjectScopeWrite({
    organizationId: params.organizationId,
    userId: params.userId,
    scope,
    teamIds: scope === "team" ? (params.data.teamIds ?? []) : [],
  });

  return ProjectModel.create({
    organizationId: params.organizationId,
    authorId: params.userId,
    data: params.data,
  });
}

export async function updateProject(params: {
  id: string;
  organizationId: string;
  userId: string;
  data: UpdateProject;
}): Promise<Project> {
  const project = await getEditableProject(params);
  const nextScope = params.data.scope ?? project.scope;

  await validateProjectScopeWrite({
    organizationId: params.organizationId,
    userId: params.userId,
    scope: nextScope,
    teamIds:
      nextScope === "team"
        ? (params.data.teamIds ?? project.teams.map((team) => team.id))
        : [],
  });

  const updated = await ProjectModel.update({
    id: params.id,
    organizationId: params.organizationId,
    data: params.data,
  });
  if (!updated) {
    throw new ApiError(404, "Project not found");
  }
  return updated;
}

export async function deleteProject(params: {
  id: string;
  organizationId: string;
  userId: string;
}): Promise<void> {
  await getEditableProject(params);
  const deleted = await ProjectModel.delete({
    id: params.id,
    organizationId: params.organizationId,
  });
  if (!deleted) {
    throw new ApiError(404, "Project not found");
  }
}

async function getEditableProject(params: {
  id: string;
  organizationId: string;
  userId: string;
}): Promise<Project> {
  const project = await ProjectModel.findById({
    id: params.id,
    organizationId: params.organizationId,
  });
  if (!project) {
    throw new ApiError(404, "Project not found");
  }

  const isProjectAdmin = await userHasPermission(
    params.userId,
    params.organizationId,
    "project",
    "admin",
  );
  if (isProjectAdmin) return project;

  if (project.scope === "personal") {
    if (project.authorId !== params.userId) {
      throw new ApiError(403, "You can only manage your own personal projects");
    }
    return project;
  }

  if (project.scope === "org") {
    throw new ApiError(403, "Only admins can manage org-scoped projects");
  }

  const isProjectTeamAdmin = await userHasPermission(
    params.userId,
    params.organizationId,
    "project",
    "team-admin",
  );
  if (!isProjectTeamAdmin) {
    throw new ApiError(
      403,
      "You need team-admin permission to manage team-scoped projects",
    );
  }

  const userTeamIds = await TeamModel.getUserTeamIds(params.userId);
  const userTeamIdSet = new Set(userTeamIds);
  const isMemberOfAnyTeam = project.teams.some((team) =>
    userTeamIdSet.has(team.id),
  );
  if (project.teams.length === 0 || !isMemberOfAnyTeam) {
    throw new ApiError(
      403,
      "You can only manage projects in teams you are a member of",
    );
  }

  return project;
}

async function validateProjectScopeWrite(params: {
  organizationId: string;
  userId: string;
  scope: ProjectScope;
  teamIds: string[];
}) {
  if (params.scope === "personal") return;

  const isProjectAdmin = await userHasPermission(
    params.userId,
    params.organizationId,
    "project",
    "admin",
  );
  if (isProjectAdmin) return;

  if (params.scope === "org") {
    throw new ApiError(
      403,
      "Only admins can create or promote org-scoped projects",
    );
  }

  if (params.teamIds.length === 0) {
    throw new ApiError(
      400,
      "A team-scoped project must be assigned to at least one team",
    );
  }

  const isProjectTeamAdmin = await userHasPermission(
    params.userId,
    params.organizationId,
    "project",
    "team-admin",
  );
  if (!isProjectTeamAdmin) {
    throw new ApiError(
      403,
      "You need team-admin permission to manage team-scoped projects",
    );
  }

  const userTeamIds = await TeamModel.getUserTeamIds(params.userId);
  const userTeamIdSet = new Set(userTeamIds);
  const invalidTeamIds = params.teamIds.filter((id) => !userTeamIdSet.has(id));
  if (invalidTeamIds.length > 0) {
    throw new ApiError(403, "You can only assign teams you are a member of");
  }
}
