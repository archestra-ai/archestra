// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { ResourcePermissions } from "@/services/resource-permissions";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

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
    ).toEqual(grants);

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
    ).toEqual(grants);

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
});
