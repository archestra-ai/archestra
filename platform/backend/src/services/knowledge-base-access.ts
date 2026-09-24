// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

import { knowledgeSourceAccessControlService } from "@/knowledge-base/source-access-control";
import { KbFileModel, KnowledgeBaseModel } from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { ApiError, type KnowledgeBase } from "@/types";

export async function canAccessKnowledgeBase(params: {
  knowledgeBase: KnowledgeBase;
  organizationId: string;
  userId?: string;
}): Promise<boolean> {
  if (params.knowledgeBase.organizationId !== params.organizationId)
    return false;
  if (!params.userId) {
    const key = {
      organizationId: params.organizationId,
      resource: "knowledgeBase" as const,
      scope: params.knowledgeBase.id,
    };
    return ResourcePermissionPolicyModel.sharedCredentialHasAccess({
      ...key,
      teamId: null,
      action: "read",
    });
  }
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
