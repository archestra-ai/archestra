// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { HookEndpointContext } from "@better-auth/core";
import RoleCompositionModel from "@/models/role-composition";

/**
 * Better Auth authorizes its organization endpoints using the member returned
 * by its adapter. Extend only the caller's authorization read for these routes;
 * stored assignments and member-list responses remain direct assignments.
 * The adapter is copied per request, never mutated globally.
 */
export async function withInheritedRoleAuthorization(params: {
  ctx: HookEndpointContext;
  getUserId: () => Promise<string | undefined>;
}) {
  const { ctx } = params;
  if (!ctx.path || !AUTHORIZATION_PATHS.has(ctx.path)) return;
  const userId = await params.getUserId();
  if (!userId) return;
  const adapter = ctx.context.adapter;
  return {
    ...adapter,
    findOne: async <T>(
      ...args: Parameters<typeof adapter.findOne>
    ): Promise<T | null> => {
      const record = await adapter.findOne<T>(...args);
      if (args[0].model !== "member" || !record || typeof record !== "object")
        return record;
      const member = record as T & {
        userId: string;
        organizationId: string;
        role: string;
      };
      if (member.userId !== userId) return record;
      const sources = await RoleCompositionModel.getUserSources({
        userId,
        organizationId: member.organizationId,
      });
      return {
        ...member,
        role: [...new Set(sources.map((source) => source.role))].join(","),
      };
    },
  };
}

const AUTHORIZATION_PATHS = new Set([
  "/organization/update-member-role",
  "/organization/invite-member",
  "/organization/remove-member",
  "/organization/cancel-invitation",
  "/organization/list-invitations",
  "/organization/list-members",
  "/organization/has-permission",
  "/organization/create-role",
  "/organization/update-role",
  "/organization/delete-role",
  "/organization/get-role",
  "/organization/list-roles",
]);
