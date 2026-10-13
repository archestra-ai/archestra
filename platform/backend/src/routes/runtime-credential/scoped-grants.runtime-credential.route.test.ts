// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { ResourcePermissionAction } from "@archestra/shared";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { createRuntimeCredentialDefinition } from "@/services/agent-runtime/runtime-credentials";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { registerRoutePermissions } from "@/test/route-permissions";
import type { RuntimeCredentialDefinition, User } from "@/types";
import routes from "./runtime-credential.routes";

/**
 * Looking after one saved credential.
 *
 * Credentials were all-or-nothing: `credential:update` let you change every
 * credential in the organization, GitHub App private keys included, and
 * without it you could change none. These pin the fix: a grant on one
 * credential reaches that credential and no other, and a grant at `*` reaches
 * every one.
 */
describe("credential object grants", () => {
  let app: FastifyInstanceWithZod;
  let caretaker: User;
  let organizationId: string;
  let caretakerRoleId: string;
  let mine: RuntimeCredentialDefinition;
  let theirs: RuntimeCredentialDefinition;

  beforeEach(
    async ({ makeOrganization, makeUser, makeMember, makeCustomRole }) => {
      organizationId = (await makeOrganization()).id;
      const admin = await makeUser();
      await makeMember(admin.id, organizationId, { role: "admin" });
      caretaker = await makeUser();
      // Opens the Credentials page and nothing more: no `*` grant names this
      // role, so every credential below is out of reach until one does.
      const role = await makeCustomRole(organizationId, {
        permission: { credential: ["read"] },
      });
      caretakerRoleId = role.id;
      await makeMember(caretaker.id, organizationId, { role: role.role });
      const create = (key: string) =>
        createRuntimeCredentialDefinition({
          organizationId,
          userId: admin.id,
          definition: {
            key,
            name: key,
            kind: "secret",
            description: "",
            icon: null,
            allowPersonal: false,
            allowOrganization: true,
          },
        });
      mine = await create("mine");
      theirs = await create("theirs");

      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        Object.assign(request, { user: caretaker, organizationId });
      });
      registerRoutePermissions(app);
      registerAuditLogHook(app);
      await app.register(routes);
    },
  );

  afterEach(async () => {
    await app.close();
  });

  const grant = async (params: {
    scope: string;
    subject: { type: "user" | "role"; id: string };
    actions: ResourcePermissionAction[];
  }) => {
    const key = {
      organizationId,
      resource: "credential" as const,
      scope: params.scope,
    };
    const policy = await ResourcePermissionPolicyModel.find(key);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: policy?.revision ?? 0,
      grants: [
        ...(policy?.grants ?? []),
        { subject: params.subject, actions: params.actions },
      ],
    });
  };

  const listedKeys = async () =>
    (await app.inject({ url: "/api/credentials" }))
      .json()
      .map((definition: { key: string }) => definition.key)
      .sort();

  const rename = (key: string) =>
    app.inject({
      method: "PATCH",
      url: `/api/credentials/${key}`,
      payload: { name: `${key} renamed` },
    });

  test("a grant on one credential reaches that credential and no other", async () => {
    expect(await listedKeys()).toEqual([]);
    expect((await rename("mine")).statusCode).toBe(404);

    await grant({
      scope: mine.id,
      subject: { type: "user", id: caretaker.id },
      actions: ["read", "use", "update"],
    });

    expect(await listedKeys()).toEqual(["mine"]);
    const renamed = await rename("mine");
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json().name).toBe("mine renamed");
    expect(
      (await app.inject({ url: "/api/credentials/mine/usage" })).statusCode,
    ).toBe(200);
    // Seeing and editing it is not deleting it.
    expect(
      (await app.inject({ method: "DELETE", url: "/api/credentials/mine" }))
        .statusCode,
    ).toBe(403);
    // Setting the shared value is an edit of the credential itself.
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/credentials/mine/organization",
          payload: { value: "s3cret" },
        })
      ).statusCode,
    ).toBe(200);

    // The other credential stays invisible, so it answers as missing.
    expect((await rename("theirs")).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/credentials/theirs/organization",
          payload: { value: "s3cret" },
        })
      ).statusCode,
    ).toBe(404);
  });

  test("a grant at * reaches every credential, including ones made later", async () => {
    await grant({
      scope: "*",
      subject: { type: "role", id: caretakerRoleId },
      actions: ["read", "use", "update", "delete", "manage-permissions"],
    });

    expect(await listedKeys()).toEqual(["mine", "theirs"]);
    expect((await rename("theirs")).statusCode).toBe(200);
    expect(
      (await app.inject({ method: "DELETE", url: "/api/credentials/theirs" }))
        .statusCode,
    ).toBe(200);
  });

  test("the creator manages what they make, and starting grants are honoured", async ({
    makeUser,
    makeCustomRole,
    makeMember,
  }) => {
    const creatorRole = await makeCustomRole(organizationId, {
      permission: { credential: ["read", "create"] },
    });
    const creator = await makeUser();
    await makeMember(creator.id, organizationId, { role: creatorRole.role });
    const asCreator = createFastifyInstance();
    asCreator.addHook("onRequest", async (request) => {
      Object.assign(request, { user: creator, organizationId });
    });
    registerRoutePermissions(asCreator);
    await asCreator.register(routes);
    try {
      const created = await asCreator.inject({
        method: "POST",
        url: "/api/credentials",
        payload: {
          key: "shared-with-caretaker",
          name: "Shared",
          kind: "secret",
          description: "",
          icon: null,
          allowPersonal: false,
          allowOrganization: true,
          initialGrants: [
            {
              subject: { type: "user", id: caretaker.id },
              actions: ["read"],
            },
          ],
        },
      });
      expect(created.statusCode, created.body).toBe(200);
      expect(
        (
          await asCreator.inject({
            method: "PATCH",
            url: "/api/credentials/shared-with-caretaker",
            payload: { name: "Renamed by its creator" },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await asCreator.close();
    }

    expect(await listedKeys()).toEqual(["shared-with-caretaker"]);
    // Read alone: visible, not editable.
    expect((await rename("shared-with-caretaker")).statusCode).toBe(403);
  });
});
