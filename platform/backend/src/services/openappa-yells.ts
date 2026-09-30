import OpenAppaYellModel from "@/models/openappa-yell";
import { ResourcePermissions } from "@/services/resource-permissions";
import { ApiError } from "@/types";

export async function yellVisibility(params: {
  organizationId: string;
  userId: string;
}) {
  const all = await ResourcePermissions.allows({
    ...params,
    resource: "log",
    scope: "*",
    action: "read",
  });
  return {
    organizationId: params.organizationId,
    callerId: all ? undefined : `user:${params.userId}`,
  };
}

export async function getOpenAppaYell(params: {
  organizationId: string;
  userId: string;
  id: string;
}) {
  const row = await OpenAppaYellModel.find({
    ...(await yellVisibility(params)),
    id: params.id,
  });
  if (!row) throw new ApiError(404, "Yell not found");
  return row;
}
