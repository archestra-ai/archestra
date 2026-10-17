// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { Permissions } from "@archestra/shared";
import { MemberModel, UserModel } from "@/models";
import { ApiError } from "@/types";

export async function getUserPermissions(params: {
  userId: string;
  organizationId: string;
}): Promise<Permissions> {
  const member = await MemberModel.getByUserId(
    params.userId,
    params.organizationId,
  );

  // TODO: this should be handled by MemberModel.getByUserId.
  // Do not touching it now because getByUserId is used all over the codebase now.
  if (!member || !member.role) {
    throw new ApiError(404, "User is not a member of any organization");
  }

  return UserModel.getUserPermissions(params.userId, params.organizationId);
}
