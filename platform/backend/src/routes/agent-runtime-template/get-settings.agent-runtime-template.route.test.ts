import { describe, expect, test } from "@/test";
import { useTemplateRouteTestApp } from "./runtime-template.test-data";

describe("GET /api/agent-runtime-templates/settings", () => {
  const ctx = useTemplateRouteTestApp();
  test("defaults existing organizations to no custom templates and protects editable configuration", async ({
    makeCustomRole,
    makeUser,
    makeMember,
  }) => {
    const response = await ctx.app.inject({
      url: "/api/agent-runtime-templates/settings",
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      revision: 0,
      templates: [],
      popularAgentOverrides: null,
    });
    ctx.caller = ctx.member;
    expect(
      (await ctx.app.inject({ url: "/api/agent-runtime-templates/settings" }))
        .statusCode,
    ).toBe(403);
    const role = await makeCustomRole(ctx.organizationId, {
      permission: { organizationSettings: ["update"] },
    });
    ctx.caller = await makeUser();
    await makeMember(ctx.caller.id, ctx.organizationId, { role: role.role });
    expect(
      (await ctx.app.inject({ url: "/api/agent-runtime-templates/settings" }))
        .statusCode,
    ).toBe(200);
  });
});
