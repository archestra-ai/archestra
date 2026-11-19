// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
import {
  hasScopedPermission,
  type ResourcePermissionAction,
} from "@archestra/shared";
import { ResourcePermissions } from "@/services/resource-permissions";
import { ApiError } from "@/types";

/**
 * Who may reach one service account.
 *
 * Reaching an account used to be a question about the caller alone: hold
 * `serviceAccount:read` and every account in the organization was yours to
 * list, rename or delete. There was no way to say "this person looks after
 * that one account", because an account was never something a grant could
 * point at. It is now, so the question is asked of the account.
 *
 * A missing account and a forbidden one answer the same way on purpose: which
 * of the two it is is itself something the caller is not entitled to know.
 */
export async function requireServiceAccountAccess(params: {
  organizationId: string;
  userId: string;
  id: string;
  action: ResourcePermissionAction;
}): Promise<void> {
  if (!(await reaches(params)))
    throw new ApiError(404, "Service account not found");
}

/** The subset of a bulk batch this caller may act on. */
export async function filterReachableServiceAccounts(params: {
  organizationId: string;
  userId: string;
  ids: string[];
  action: ResourcePermissionAction;
}): Promise<Set<string>> {
  const verdicts = await Promise.all(
    params.ids.map(async (id) => ({
      id,
      allowed: await reaches({ ...params, id }),
    })),
  );
  return new Set(
    verdicts.filter((verdict) => verdict.allowed).map((verdict) => verdict.id),
  );
}

// === Internal helpers

/**
 * One account, one action, answered for a converted deployment and an
 * unconverted one alike.
 *
 * `ResourcePermissions.allows` reads stored grants and nothing else, so on a
 * deployment whose policies have not been written yet it answers "no" to
 * everyone — administrators included. `getEffective` is the primitive that
 * knows the difference: with a migrated policy it resolves grants, and without
 * one it falls back to the role actions the grants were converted from. Only
 * the second answers correctly in both states, so the gate is built on it.
 */
async function reaches(params: {
  organizationId: string;
  userId: string;
  id: string;
  action: ResourcePermissionAction;
}): Promise<boolean> {
  const context = {
    organizationId: params.organizationId,
    userId: params.userId,
    resource: "serviceAccount" as const,
    scope: params.id,
  };
  try {
    const effective = await ResourcePermissions.getEffective(context);
    return hasScopedPermission({
      grants: effective.grants,
      required: { ...context, action: params.action },
    });
  } catch (error) {
    // A missing account answers the same way a refused one does: which of the
    // two it is is itself something the caller is not entitled to know.
    if (error instanceof ApiError && error.statusCode === 404) return false;
    throw error;
  }
}
