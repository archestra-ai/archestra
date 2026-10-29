// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { ResourcePermissions } from "@/services/resource-permissions";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type TestAccess,
  test,
} from "@/test";
import type { User } from "@/types";

// The creator's own grant, beside the audience they named.
const CREATOR_ACTIONS = [
  "read",
  "use",
  "update",
  "delete",
  "manage-permissions",
];

describe("scoped knowledge grants", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    user = await makeUser();
    organizationId = (await makeOrganization()).id;
    await makeMember(user.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    const { default: knowledgeBaseRoutes } = await import("./knowledge-base");
    await app.register(knowledgeBaseRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("shares a knowledge base with a named user at creation", async ({
    makeMember,
    makeUser,
  }) => {
    const recipient = await makeUser();
    await makeMember(recipient.id, organizationId);
    const outsider = await makeUser();
    await makeMember(outsider.id, organizationId);

    const grants = [
      {
        subject: { type: "user" as const, id: recipient.id },
        actions: ["read" as const, "use" as const],
      },
    ];
    const response = await app.inject({
      method: "POST",
      url: "/api/knowledge-bases",
      payload: {
        name: "Shared research",
        initialGrants: grants,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const id = response.json().id;

    // Knowledge carries no author column, so the creator is not added.
    expect(
      (
        await ResourcePermissionPolicyModel.find({
          organizationId,
          resource: "knowledgeBase",
          scope: id,
        })
      )?.grants,
    ).toEqual([
      ...grants,
      { subject: { type: "user", id: user.id }, actions: CREATOR_ACTIONS },
    ]);

    const scoped = {
      organizationId,
      resource: "knowledgeBase" as const,
      scope: id,
    };
    expect(
      (
        await ResourcePermissions.getEffective({
          ...scoped,
          userId: recipient.id,
        })
      ).grants.map((grant) => grant.action),
    ).toEqual(["read", "use"]);
    expect(
      (
        await ResourcePermissions.getEffective({
          ...scoped,
          userId: outsider.id,
        })
      ).grants,
    ).toEqual([]);
  });

  test("shares a connector with a named user at creation", async ({
    makeMember,
    makeUser,
  }) => {
    const recipient = await makeUser();
    await makeMember(recipient.id, organizationId);
    const outsider = await makeUser();
    await makeMember(outsider.id, organizationId);

    const grants = [
      {
        subject: { type: "user" as const, id: recipient.id },
        actions: ["read" as const],
      },
    ];
    const response = await app.inject({
      method: "POST",
      url: "/api/connectors",
      payload: {
        name: "Shared connector",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://test.atlassian.net",
          isCloud: true,
          projectKey: "TEST",
        },
        credentials: { email: "user@example.com", apiToken: "token" },
        initialGrants: grants,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const id = response.json().id;

    expect(
      (
        await ResourcePermissionPolicyModel.find({
          organizationId,
          resource: "knowledgeConnector",
          scope: id,
        })
      )?.grants,
    ).toEqual([
      ...grants,
      { subject: { type: "user", id: user.id }, actions: CREATOR_ACTIONS },
    ]);

    const scoped = {
      organizationId,
      resource: "knowledgeConnector" as const,
      scope: id,
    };
    expect(
      (
        await ResourcePermissions.getEffective({
          ...scoped,
          userId: recipient.id,
        })
      ).grants.map((grant) => grant.action),
    ).toEqual(["read"]);
    expect(
      (
        await ResourcePermissions.getEffective({
          ...scoped,
          userId: outsider.id,
        })
      ).grants,
    ).toEqual([]);
  });

  test("a create request without grants does not publish the base", async ({
    makeMember,
    makeUser,
  }) => {
    const member = await makeUser();
    await makeMember(member.id, organizationId);

    // The retired visibility field is refused rather than read.
    const refused = await app.inject({
      method: "POST",
      url: "/api/knowledge-bases",
      payload: { name: "Everyone", visibility: "org-wide" },
    });
    expect(refused.statusCode).toBe(400);

    const response = await app.inject({
      method: "POST",
      url: "/api/knowledge-bases",
      payload: { name: "Everyone" },
    });
    expect(response.statusCode, response.body).toBe(200);

    // Publishing to the organization is a delegation act the permissions
    // editor performs deliberately, so a create request starts it empty.
    expect(
      (
        await ResourcePermissions.getEffective({
          organizationId,
          resource: "knowledgeBase",
          scope: response.json().id,
          userId: member.id,
        })
      ).grants,
    ).toEqual([]);
  });

  test("access filter splits rows by how the caller reaches them, ignoring wildcard grants", async ({
    makeKnowledgeBase,
    makeMember,
    makeTeam,
    makeTeamMember,
    makeUser,
  }) => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const otherUser = await makeUser();
    await makeMember(otherUser.id, organizationId, { role: "member" });
    const myTeam = await makeTeam(organizationId, user.id);
    await makeTeamMember(myTeam.id, user.id);
    const otherTeam = await makeTeam(organizationId, otherUser.id);

    const seed = (name: string, access: TestAccess, createdBy = otherUser.id) =>
      makeKnowledgeBase(organizationId, {
        name: `${name} ${suffix}`,
        createdBy,
        access,
      });
    await seed("Mine", "personal", user.id);
    await seed("Other Personal", "personal");
    await seed("Org", "org");
    await seed("My Team", { teams: [myTeam.id] });
    await seed("Other Team", { teams: [otherTeam.id] });
    await seed("Shared With Me", { users: [user.id] });

    const list = async (access?: string) => {
      const response = await app.inject({
        method: "GET",
        url: `/api/knowledge-bases?limit=50&search=${suffix}${access ? `&access=${access}` : ""}`,
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json();
      expect(body.pagination.total).toBe(body.data.length);
      return body.data
        .map((kb: { name: string }) => kb.name.replace(` ${suffix}`, ""))
        .sort();
    };

    // The admin reads every knowledge base through a `*` grant, which the
    // filter must not count as "shared".
    expect(await list()).toEqual([
      "Mine",
      "My Team",
      "Org",
      "Other Personal",
      "Other Team",
      "Shared With Me",
    ]);
    expect(await list("mine,shared,org")).toEqual([
      "Mine",
      "My Team",
      "Org",
      "Shared With Me",
    ]);
    expect(await list("others")).toEqual(["Other Personal", "Other Team"]);
    expect(await list("mine")).toEqual(["Mine"]);
    expect(await list("shared")).toEqual(["My Team", "Shared With Me"]);
    expect(await list("org")).toEqual(["Org"]);
  });
});
