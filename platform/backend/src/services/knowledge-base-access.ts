// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { enterpriseTier } from "@/enterprise-tier";
import { knowledgeSourceAccessControlService } from "@/knowledge-base/source-access-control";
import { KbFileModel, KnowledgeBaseModel, TeamModel } from "@/models";
import { ApiError, type KnowledgeBase } from "@/types";

export async function canAccessKnowledgeBase(params: {
  knowledgeBase: KnowledgeBase;
  organizationId: string;
  userId?: string;
}): Promise<boolean> {
  if (params.knowledgeBase.organizationId !== params.organizationId)
    return false;
  if (!params.userId) return params.knowledgeBase.visibility === "org-wide";
  const access =
    await knowledgeSourceAccessControlService.buildAccessControlContext({
      userId: params.userId,
      organizationId: params.organizationId,
    });
  return knowledgeSourceAccessControlService.canAccessKnowledgeBase(
    access,
    params.knowledgeBase,
  );
}

export async function findAccessibleKnowledgeBase(params: {
  id: string;
  organizationId: string;
  userId?: string;
}): Promise<KnowledgeBase> {
  const knowledgeBase = await KnowledgeBaseModel.findById(params.id);
  if (
    !knowledgeBase ||
    !(await canAccessKnowledgeBase({ ...params, knowledgeBase }))
  ) {
    throw new ApiError(404, "Knowledge base not found");
  }
  return knowledgeBase;
}

export async function validateKnowledgeBaseAccess(params: {
  organizationId: string;
  visibility: KnowledgeBase["visibility"];
  teamIds: string[];
  current?: KnowledgeBase;
}): Promise<void> {
  if (
    params.visibility === "private" &&
    params.current &&
    !params.current.createdBy
  ) {
    throw new ApiError(
      400,
      "Knowledge bases without an owner cannot be made personal",
    );
  }
  if (params.visibility === "team-scoped") {
    if (params.teamIds.length === 0)
      throw new ApiError(
        400,
        "At least one team must be selected for team-scoped knowledge bases",
      );
    if (
      params.current?.visibility !== "team-scoped" &&
      !enterpriseTier.isKnowledgeBaseActive()
    ) {
      throw new ApiError(
        403,
        "Team-scoped knowledge bases require an enterprise license",
      );
    }
  }
  if (params.visibility === "team-scoped" && params.teamIds.length) {
    const teams = await TeamModel.findByOrganization(params.organizationId);
    const knownIds = new Set(teams.map((team) => team.id));
    if (params.teamIds.some((id) => !knownIds.has(id))) {
      throw new ApiError(400, "One or more teams are not in this organization");
    }
  }
}

export async function findAccessibleKnowledgeBasesForFiles(params: {
  fileIds: string[];
  organizationId: string;
  userId: string;
}) {
  const access =
    await knowledgeSourceAccessControlService.buildAccessControlContext(params);
  return KbFileModel.findKnowledgeBasesForFiles(params.fileIds, {
    userId: params.userId,
    teamIds: access.teamIds,
    canManageAll: access.canReadAll,
  });
}
