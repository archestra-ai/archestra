import { userHasPermission } from "@/auth";
import ProjectModel from "@/models/project";
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
  await validateProjectScopeWrite({
    organizationId: params.organizationId,
    userId: params.userId,
    scope: params.data.scope,
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
  if (!isProjectAdmin && project.authorId !== params.userId) {
    throw new ApiError(
      403,
      "You do not have permission to modify this project",
    );
  }

  return project;
}

async function validateProjectScopeWrite(params: {
  organizationId: string;
  userId: string;
  scope: ProjectScope;
}) {
  if (params.scope === "personal") return;

  const isProjectAdmin = await userHasPermission(
    params.userId,
    params.organizationId,
    "project",
    "admin",
  );
  if (!isProjectAdmin) {
    throw new ApiError(
      403,
      "Project sharing requires project admin permission",
    );
  }
}
