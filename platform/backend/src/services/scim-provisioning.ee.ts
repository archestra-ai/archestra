// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { AccountModel, MemberModel, UserModel } from "@/models";
import SessionModel from "@/models/session";
import { cancelUnfinishedTasksOfUser } from "@/services/agent-runtime/start-task";
import { createPendingSignupMember } from "@/services/pending-signup-member";
import { softDeletedUsers } from "@/services/soft-deleted-users";
import { isUniqueConstraintError } from "@/utils/db";

/**
 * SCIM 2.0 user provisioning (RFC 7643/7644), for an identity provider such
 * as Entra ID or Okta that pushes the members of a group.
 *
 * A pushed user becomes a member who has not signed up yet (see
 * `createPendingSignupMember`): they can be added to teams before their first
 * login, and their first SSO sign-in links onto the same user.
 *
 * - The SCIM `userName` is the user's email in Archestra.
 * - A pushed user gets no invitation link, so SSO is the only way in. A
 *   password sign-up through an invitation link would replace the user and
 *   drop their teams.
 * - SCIM never deletes a user. Deactivating or deleting soft-deletes them
 *   (`user.soft_deleted`): they cannot sign in or call the API, their sessions
 *   end, their tasks in progress are canceled, and their data, memberships
 *   and teams stay. Activating them again clears it.
 */
class ScimProvisioningService {
  async listUsers(params: {
    organizationId: string;
    userName?: string;
    startIndex: number;
    count: number;
  }): Promise<ScimListResponse> {
    const { organizationId, startIndex, count } = params;
    if (params.userName !== undefined) {
      const user = await this.getUserByEmail({
        organizationId,
        email: params.userName,
      });
      const resources = user && startIndex === 1 && count > 0 ? [user] : [];
      return listResponse({
        totalResults: user ? 1 : 0,
        startIndex,
        resources,
      });
    }

    const page = await MemberModel.findAllPaginated({
      organizationId,
      pagination: { limit: count, offset: startIndex - 1 },
    });
    const users = await UserModel.findByIds(
      page.data.map((member) => member.userId),
    );
    return listResponse({
      totalResults: page.pagination.total,
      startIndex,
      resources: page.data.flatMap((member) => {
        const user = users.get(member.userId);
        return user ? [toScimUser(user)] : [];
      }),
    });
  }

  async getUser(params: {
    organizationId: string;
    userId: string;
  }): Promise<ScimUser | null> {
    const user = await UserModel.getById(params.userId);
    if (!user) return null;
    const member = await MemberModel.getByUserId(
      user.id,
      params.organizationId,
    );
    return member ? toScimUser(user) : null;
  }

  async createUser(params: {
    organizationId: string;
    userName: string;
    name: string;
    /** `false` creates the user soft-deleted, as the identity provider has them. */
    active: boolean;
  }): Promise<{ status: "created"; user: ScimUser } | { status: "exists" }> {
    try {
      const { userId } = await createPendingSignupMember({
        organizationId: params.organizationId,
        email: params.userName,
        name: params.name,
        scimProvisioned: true,
      });
      if (!params.active)
        await UserModel.setSoftDeleted({ userId, softDeleted: new Date() });
      const user = await this.getUser({
        organizationId: params.organizationId,
        userId,
      });
      if (!user) throw new Error("SCIM: created user is not a member");
      return { status: "created", user };
    } catch (error) {
      if (isUniqueConstraintError(error)) return { status: "exists" };
      throw error;
    }
  }

  /**
   * Deactivate or delete: soft-delete the user, end their sessions and cancel
   * their tasks in progress. A user soft-deleted earlier keeps the first date.
   */
  async softDeleteUser(params: {
    organizationId: string;
    userId: string;
  }): Promise<ScimUser | null> {
    const user = await this.getUser(params);
    if (!user) return null;
    if (user.active) {
      await UserModel.setSoftDeleted({
        userId: params.userId,
        softDeleted: new Date(),
      });
      softDeletedUsers.invalidate(params.userId);
    }
    await SessionModel.deleteAllByUserId(params.userId);
    await cancelUnfinishedTasksOfUser({
      userId: params.userId,
      organizationId: params.organizationId,
      statusReason: "The task's user was deactivated in the identity provider.",
    });
    return this.getUser(params);
  }

  /**
   * Apply a new `userName` (the user's email) while the user has not signed in
   * yet, so fixing the identity provider's mapping fixes users it already
   * pushed. After the first SSO sign-in, every sign-in refreshes the email from
   * the identity provider's claims, so SCIM leaves it alone.
   */
  async changeUserName(params: {
    organizationId: string;
    userId: string;
    userName: string;
  }): Promise<"changed" | "unchanged" | "exists" | "not_found"> {
    const user = await this.getUser(params);
    if (!user) return "not_found";
    const email = params.userName.toLowerCase();
    if (user.userName === email) return "unchanged";
    if (await AccountModel.getByUserId(params.userId)) return "unchanged";
    try {
      await UserModel.patch(params.userId, { email, updatedAt: new Date() });
      return "changed";
    } catch (error) {
      if (isUniqueConstraintError(error)) return "exists";
      throw error;
    }
  }

  /**
   * Apply a new `displayName` (the user's name) while the user has not signed
   * in yet, for the same reason as `changeUserName`: after the first SSO
   * sign-in the name comes from the identity provider's claims.
   */
  async changeDisplayName(params: {
    organizationId: string;
    userId: string;
    displayName: string;
  }): Promise<"changed" | "unchanged" | "not_found"> {
    const user = await this.getUser(params);
    if (!user) return "not_found";
    if (user.displayName === params.displayName) return "unchanged";
    if (await AccountModel.getByUserId(params.userId)) return "unchanged";
    await UserModel.patch(params.userId, {
      name: params.displayName,
      updatedAt: new Date(),
    });
    return "changed";
  }

  /** Activate again: the user can sign in. */
  async restoreUser(params: {
    organizationId: string;
    userId: string;
  }): Promise<ScimUser | null> {
    const user = await this.getUser(params);
    if (!user) return null;
    if (!user.active) {
      await UserModel.setSoftDeleted({
        userId: params.userId,
        softDeleted: null,
      });
      softDeletedUsers.invalidate(params.userId);
    }
    return this.getUser(params);
  }

  private async getUserByEmail(params: {
    organizationId: string;
    email: string;
  }): Promise<ScimUser | null> {
    const user = await UserModel.findByEmail(params.email.toLowerCase());
    if (!user) return null;
    return this.getUser({
      organizationId: params.organizationId,
      userId: user.id,
    });
  }
}

export const scimProvisioningService = new ScimProvisioningService();

const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const SCIM_LIST_RESPONSE_SCHEMA =
  "urn:ietf:params:scim:api:messages:2.0:ListResponse";

type ScimUser = ReturnType<typeof toScimUser>;
type ScimListResponse = ReturnType<typeof listResponse>;

// ===== internal helpers =====

function toScimUser(user: {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  softDeleted: Date | null;
}) {
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: user.id,
    userName: user.email,
    displayName: user.name,
    name: { formatted: user.name },
    emails: [{ value: user.email, type: "work", primary: true }],
    active: user.softDeleted === null,
    meta: {
      resourceType: "User",
      created: user.createdAt.toISOString(),
      lastModified: user.updatedAt.toISOString(),
    },
  };
}

function listResponse(params: {
  totalResults: number;
  startIndex: number;
  resources: ScimUser[];
}) {
  return {
    schemas: [SCIM_LIST_RESPONSE_SCHEMA],
    totalResults: params.totalResults,
    startIndex: params.startIndex,
    itemsPerPage: params.resources.length,
    Resources: params.resources,
  };
}
