// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { ResourcePermissions } from "@/services/resource-permissions";
import { beforeEach, describe, expect, test, useRouteTestApp } from "@/test";
import knowledgeFileRoutes from "./knowledge-file.routes";

const AUTHOR_ACTIONS = [
  "read",
  "use",
  "update",
  "delete",
  "manage-permissions",
];

describe("scoped knowledge file grants", () => {
  const ctx = useRouteTestApp(knowledgeFileRoutes);

  beforeEach(async ({ makeMember }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
  });

  test("shares an uploaded file with a named user at creation", async ({
    makeMember,
    makeUser,
  }) => {
    const recipient = await makeUser();
    await makeMember(recipient.id, ctx.organizationId);
    const outsider = await makeUser();
    await makeMember(outsider.id, ctx.organizationId);

    const grants = [
      {
        subject: { type: "user" as const, id: recipient.id },
        actions: ["read" as const, "use" as const],
      },
    ];
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/knowledge-files",
      payload: {
        filename: "notes.txt",
        mimeType: "text/plain",
        content: Buffer.from("Shared at creation").toString("base64"),
        initialGrants: grants,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const id = response.json().id;

    expect(
      (
        await ResourcePermissionPolicyModel.find({
          organizationId: ctx.organizationId,
          resource: "knowledgeFile",
          scope: id,
        })
      )?.grants,
    ).toEqual([
      ...grants,
      { subject: { type: "user", id: ctx.user.id }, actions: AUTHOR_ACTIONS },
    ]);

    const scoped = {
      organizationId: ctx.organizationId,
      resource: "knowledgeFile" as const,
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
});
