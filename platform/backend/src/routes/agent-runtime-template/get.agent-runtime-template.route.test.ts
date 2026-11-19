import AgentRuntimeTemplateModel from "@/models/agent-runtime-template";
import { describe, expect, test } from "@/test";
import {
  grantRuntime,
  makeTemplate,
  useTemplateRouteTestApp,
} from "./runtime-template.test-data";

describe("GET /api/agent-runtime-templates/:id", () => {
  const ctx = useTemplateRouteTestApp();
  test("requires use of the runtime and refuses hidden or cross-organization templates", async ({
    makeOrganization,
    makeMember,
    makeCustomRole,
    makeUser,
  }) => {
    const template = makeTemplate();
    const hidden = makeTemplate({ name: "Hidden workspace", hidden: true });
    await AgentRuntimeTemplateModel.saveSettings({
      organizationId: ctx.organizationId,
      settings: { revision: 0, templates: [template, hidden] },
      popularAgentOverrides: null,
    });
    ctx.caller = ctx.viewer;
    expect(
      (
        await ctx.app.inject({
          url: `/api/agent-runtime-templates/${template.id}`,
        })
      ).statusCode,
    ).toBe(403);
    ctx.caller = ctx.member;
    expect(
      (
        await ctx.app.inject({
          url: `/api/agent-runtime-templates/${template.id}`,
        })
      ).statusCode,
    ).toBe(403);
    ctx.member = await makeUser();
    ctx.caller = ctx.member;
    const role = await makeCustomRole(ctx.organizationId, {
      permission: { agent: ["create"] },
    });
    await makeMember(ctx.member.id, ctx.organizationId, { role: role.role });
    await grantRuntime({
      organizationId: ctx.organizationId,
      scope: template.id,
      userId: ctx.member.id,
      actions: ["read", "use"],
    });
    const resolved = await ctx.app.inject({
      url: `/api/agent-runtime-templates/${template.id}`,
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(resolved.json()).toEqual(template);
    expect(
      (
        await ctx.app.inject({
          url: `/api/agent-runtime-templates/${hidden.id}`,
        })
      ).statusCode,
    ).toBe(404);
    ctx.organizationId = (await makeOrganization()).id;
    await makeMember(ctx.member.id, ctx.organizationId, { role: "admin" });
    expect(
      (
        await ctx.app.inject({
          url: `/api/agent-runtime-templates/${template.id}`,
        })
      ).statusCode,
    ).toBe(404);
  });
});
