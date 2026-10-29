import {
  serviceAccountIdFromUserId,
  serviceAccountUserId,
} from "@/auth/service-account-user-id";
import ServiceAccountModel from "@/models/service-account";
import { ResourcePermissions } from "@/services/resource-permissions";
import { ApiError } from "@/types";

/** A bound OAuth client acts as a live account, never as its human creator. */
export async function resolveOauthServiceAccount(params: {
  serviceAccountId: string;
  organizationId: string;
}) {
  const account = await ServiceAccountModel.findById(
    params.serviceAccountId,
    params.organizationId,
  );
  if (!account || account.disabled)
    throw new ApiError(401, "OAuth service account is no longer available.");
  return account;
}

/** Binding a credential lets its holders act as the account; require management. */
export async function validateOauthServiceAccountBinding(params: {
  serviceAccountId?: string | null;
  organizationId: string;
  userId: string;
  grantType: string;
  creating?: boolean;
}): Promise<string | null | undefined> {
  const id =
    params.serviceAccountId ??
    (params.creating ? serviceAccountIdFromUserId(params.userId) : undefined);
  if (!id) return params.serviceAccountId;
  if (params.grantType !== "client_credentials")
    throw new ApiError(
      400,
      "Only client_credentials clients can act as a service account.",
    );
  const account = await ServiceAccountModel.findById(id, params.organizationId);
  if (!account || account.disabled)
    throw new ApiError(
      400,
      "Service account is unavailable in this organization.",
    );
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  if (
    params.userId !== serviceAccountUserId(id) &&
    !(await ResourcePermissions.allows({
      organizationId: params.organizationId,
      userId: params.userId,
      resource: "serviceAccount",
      scope: id,
      action: "update",
    }))
  )
    throw new ApiError(
      403,
      "Managing this service account is required to bind an OAuth client.",
    );
  // SPDX-SnippetEnd
  return id;
}
