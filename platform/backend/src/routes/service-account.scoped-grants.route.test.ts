// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@archestra/shared";
import { memberPermissions } from "@archestra/shared/access-control";
import { vi } from "vitest";
import db from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import MemberModel from "@/models/member";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { createFastifyInstance, type FastifyInstanceWithZod } from "@/server";
import { ResourcePermissions } from "@/services/resource-permissions";
import { runScopedResourcePermissionCutover } from "@/services/resource-permissions-cutover";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import serviceAccountRoutes from "./service-account";

vi.mock("@/observability");

/**
 * Looking after one service account.
 *
 * Before grants, service accounts were all-or-nothing: `serviceAccount:update`
 * let you rename, re-role, re-key and delete every account in the
 * organization, and without it you could touch none. There was no way to say
 * "this person looks after that one account", because an account was never
 * something a grant could point at. These tests pin the two halves of that
 * being fixed — a named recipient reaches the one account named, and reaches
 * no other.
 */
describe("service account object grants", () => {
  let app: FastifyInstanceWithZod;
  let caretaker: User;
  let organizationId: string;

  beforeEach(
    async ({ makeOrganization, makeUser, makeMember, makeCustomRole }) => {
      organizationId = (await makeOrganization()).id;
      caretaker = await makeUser();
      // A role that withholds every service-account action, so nothing below
      // can pass on resource-wide authority by accident.
      const role = await makeCustomRole(organizationId, { permission: {} });
      await makeMember(caretaker.id, organizationId, { role: role.role });
      await db.transaction((tx) =>
        ResourcePermissionPolicyModel.initializeOrganization({
          tx,
          organizationId,
        }),
      );
      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        Object.assign(request, { user: caretaker, organizationId });
      });
      registerAuditLogHook(app);
      await app.register(serviceAccountRoutes);
    },
  );

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const grant = async (
    scope: string,
    actions: ("read" | "use" | "update" | "delete" | "manage-permissions")[],
  ) => {
    const key = {
      organizationId,
      resource: "serviceAccount" as const,
      scope,
    };
    const policy = await ResourcePermissionPolicyModel.find(key);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: policy?.revision ?? 0,
      // An empty action list clears the policy, which is how a test revokes.
      grants: actions.length
        ? [{ subject: { type: "user", id: caretaker.id }, actions }]
        : [],
    });
  };

  test("a grant recipient manages the one account it names and no other", async ({
    makeServiceAccount,
  }) => {
    const mine = await makeServiceAccount(organizationId, { name: "mine" });
    const theirs = await makeServiceAccount(organizationId, { name: "theirs" });
    await runScopedResourcePermissionCutover();

    // Nothing yet: the role withholds every service-account action, and no
    // grant names this person.
    expect(
      (await app.inject({ url: `/api/service-accounts/${mine.id}` }))
        .statusCode,
    ).toBe(404);

    await grant(mine.id, ["read", "update", "delete"]);

    expect(
      (await app.inject({ url: `/api/service-accounts/${mine.id}` }))
        .statusCode,
    ).toBe(200);
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/service-accounts/${mine.id}`,
      payload: { name: "renamed" },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json().name).toBe("renamed");

    // The grant is on one account, so it decides one account.
    expect(
      (await app.inject({ url: `/api/service-accounts/${theirs.id}` }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/service-accounts/${theirs.id}`,
          payload: { name: "should not apply" },
        })
      ).statusCode,
    ).toBe(404);

    // And the list agrees with the single-object answer, or an account you
    // cannot open is still sitting there in the table.
    const listed = await app.inject({ url: "/api/service-accounts" });
    expect(listed.json().map((account: { id: string }) => account.id)).toEqual([
      mine.id,
    ]);
  });

  test("the grant reaches the client that decides whether to show the page", async ({
    makeServiceAccount,
  }) => {
    // `/settings/service-accounts` asks for the `serviceAccount:read` role
    // action, which a per-object grantee does not have. `hasPagePermissions`
    // accepts a scoped read capability instead, and this is where that
    // capability comes from — `resolveAll`, behind GET
    // /api/resource-permissions. Without the resource listed here the grantee
    // would be told they have access and then shown a Forbidden page.
    const account = await makeServiceAccount(organizationId);
    await runScopedResourcePermissionCutover();

    expect(
      await ResourcePermissions.resolveAll({
        organizationId,
        userId: caretaker.id,
      }),
    ).not.toContainEqual(
      expect.objectContaining({ resource: "serviceAccount" }),
    );

    await grant(account.id, ["read"]);

    expect(
      await ResourcePermissions.resolveAll({
        organizationId,
        userId: caretaker.id,
      }),
    ).toContainEqual({
      organizationId,
      resource: "serviceAccount",
      scope: account.id,
      action: "read",
    });
  });

  test("the role action alone no longer reaches an account", async ({
    makeCustomRole,
    makeServiceAccount,
  }) => {
    // The case a reviewer worries about, because emptying these routes'
    // entries in `requiredEndpointPermissionsMap` moved the decision. A role
    // carrying every service-account action is the most permissive thing the
    // old model had, and on its own it now reaches nothing: the organization's
    // policy names the two admin tiers, and this role is not one of them.
    // This is the state a custom role authored after the upgrade is in.
    const role = await makeCustomRole(organizationId, {
      permission: { serviceAccount: ["read", "update", "delete"] },
    });
    await MemberModel.updateRole(caretaker.id, organizationId, role.role);
    const account = await makeServiceAccount(organizationId);

    expect(
      (await app.inject({ url: `/api/service-accounts/${account.id}` }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/service-accounts/${account.id}`,
          payload: { name: "should not apply" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/service-accounts/${account.id}`,
        })
      ).statusCode,
    ).toBe(404);
    expect((await app.inject({ url: "/api/service-accounts" })).json()).toEqual(
      [],
    );
  });

  test("revoking a role's organization-wide grant takes its accounts with it", async ({
    makeCustomRole,
    makeServiceAccount,
  }) => {
    // The same claim from the other direction. The conversion turns this
    // role's `serviceAccount:read` into a grant on `*`, so it reaches every
    // account — until that grant is removed, at which point the role action it
    // was converted from is worth nothing on its own.
    const role = await makeCustomRole(organizationId, {
      permission: { serviceAccount: ["read"] },
    });
    await MemberModel.updateRole(caretaker.id, organizationId, role.role);
    const account = await makeServiceAccount(organizationId);
    await runScopedResourcePermissionCutover();

    expect(
      (await app.inject({ url: `/api/service-accounts/${account.id}` }))
        .statusCode,
    ).toBe(200);

    await grant("*", []);

    expect(
      (await app.inject({ url: `/api/service-accounts/${account.id}` }))
        .statusCode,
    ).toBe(404);
  });

  test("minting a key needs the account's update action, not just read", async ({
    makeServiceAccount,
  }) => {
    const account = await makeServiceAccount(organizationId);
    await runScopedResourcePermissionCutover();
    await grant(account.id, ["read"]);

    // A key authenticates as the account with the account's full role set, so
    // it is an edit, not a read.
    const refused = await app.inject({
      method: "POST",
      url: `/api/service-accounts/${account.id}/tokens`,
      payload: { name: "ci", expiresIn: null },
    });
    expect(refused.statusCode).toBe(404);

    await grant(account.id, ["read", "update"]);
    const minted = await app.inject({
      method: "POST",
      url: `/api/service-accounts/${account.id}/tokens`,
      payload: { name: "ci", expiresIn: null },
    });
    expect(minted.statusCode, minted.body).toBe(200);
    expect(minted.json().token).toBeTruthy();
  });

  test("a bulk request applies the ids it may and reports the rest", async ({
    makeServiceAccount,
  }) => {
    const mine = await makeServiceAccount(organizationId, { name: "mine" });
    const theirs = await makeServiceAccount(organizationId, { name: "theirs" });
    await runScopedResourcePermissionCutover();
    await grant(mine.id, ["read", "delete"]);

    const response = await app.inject({
      method: "DELETE",
      url: "/api/service-accounts/bulk",
      payload: { ids: [mine.id, theirs.id] },
    });

    expect(response.statusCode, response.body).toBe(200);
    const outcome = response.json();
    expect(outcome.succeeded).toEqual([{ id: mine.id, name: "mine" }]);
    // The whole `failed` entry, not just its id: the gate refuses by making
    // the account unloadable, so a refused id has to come back in exactly the
    // shape an id belonging to another organization already did.
    expect(outcome.failed).toEqual([
      { id: theirs.id, name: null, error: "Service account not found" },
    ]);
  });

  test("the creator of a new account can manage it without a role action", async () => {
    await runScopedResourcePermissionCutover();
    // Creating still takes the role action — there is no object yet to hold a
    // grant, so nothing else could authorize it.
    const withoutCreate = await app.inject({
      method: "POST",
      url: "/api/service-accounts",
      payload: { name: "no-create", role: MEMBER_ROLE_NAME },
    });
    expect(withoutCreate.statusCode).toBe(403);

    const role = await makeCreateOnlyRole();
    await MemberModel.updateRole(caretaker.id, organizationId, role);

    const created = await app.inject({
      method: "POST",
      url: "/api/service-accounts",
      payload: { name: "mine-to-keep", role: MEMBER_ROLE_NAME },
    });
    expect(created.statusCode, created.body).toBe(200);

    // The account it just made answers to it, though its role carries no
    // read, update or delete action for service accounts at all.
    const id = created.json().id;
    expect(
      (await app.inject({ url: `/api/service-accounts/${id}` })).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/service-accounts/${id}`,
        })
      ).statusCode,
    ).toBe(200);
  });

  /**
   * `serviceAccount:create` and nothing else about service accounts.
   *
   * The rest of the member permission set comes along because assigning a role
   * to an account requires holding everything that role carries, and the
   * account below is given `member` — an unrelated rule, but one that would
   * otherwise refuse the create for the wrong reason.
   */
  async function makeCreateOnlyRole() {
    const { default: OrganizationRoleModel } = await import(
      "@/models/organization-role"
    );
    const role = await OrganizationRoleModel.create({
      organizationId,
      role: "service-account-creator",
      name: "Service account creator",
      permission: { ...memberPermissions, serviceAccount: ["create"] },
    });
    return role.role;
  }
});

/**
 * The window before the conversion has written any policy.
 *
 * `ResourcePermissions.allows` reads stored grants only. A gate built on it
 * answers "no" to everyone while the policies are absent — administrators
 * included — so the whole feature reads as "no service accounts exist". The
 * web process converts before it registers routes or listens, so a deployed
 * replica should never serve a request in this state; this describe block
 * exists because that is an argument about a startup sequence in a file this
 * code does not own, and the failure it guards against is silent and total.
 */
describe("service accounts before the conversion has run", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let actor: User;

  const boot = async (
    makeMember: (
      userId: string,
      organizationId: string,
      overrides?: { role?: string },
    ) => Promise<unknown>,
    role: string,
  ) => {
    await makeMember(actor.id, organizationId, { role });
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user: actor, organizationId });
    });
    registerAuditLogHook(app);
    await app.register(serviceAccountRoutes);
  };

  beforeEach(async ({ makeOrganization, makeUser }) => {
    // `legacyPermissions` skips `initializeOrganization`, so not a single
    // policy row exists — exactly the state an upgrade starts from.
    organizationId = (await makeOrganization({ legacyPermissions: true })).id;
    actor = await makeUser();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
  });

  test("an admin still reaches every account", async ({
    makeMember,
    makeServiceAccount,
  }) => {
    await boot(makeMember, ADMIN_ROLE_NAME);
    const account = await makeServiceAccount(organizationId, { name: "ci" });

    const read = await app.inject({
      url: `/api/service-accounts/${account.id}`,
    });
    expect(read.statusCode, read.body).toBe(200);

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/service-accounts/${account.id}`,
      payload: { name: "renamed" },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);

    const listed = await app.inject({ url: "/api/service-accounts" });
    expect(listed.json().map((row: { id: string }) => row.id)).toEqual([
      account.id,
    ]);
  });

  test("a role without the action still reaches nothing", async ({
    makeMember,
    makeCustomRole,
    makeServiceAccount,
  }) => {
    const role = await makeCustomRole(organizationId, { permission: {} });
    await boot(makeMember, role.role);
    const account = await makeServiceAccount(organizationId);

    expect(
      (await app.inject({ url: `/api/service-accounts/${account.id}` }))
        .statusCode,
    ).toBe(404);
    expect((await app.inject({ url: "/api/service-accounts" })).json()).toEqual(
      [],
    );
  });
});
