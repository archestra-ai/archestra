import { vi } from "vitest";
import { agentSandboxApi } from "@/k8s/agent-runtime/sandbox-api";
import AgentModel from "@/models/agent";
import AgentRuntimeTemplateModel from "@/models/agent-runtime-template";
import agentRoutes from "@/routes/agent";
import { beforeEach, describe, expect, test } from "@/test";
import {
  makeTemplate,
  useTemplateRouteTestApp,
} from "./runtime-template.test-data";

vi.mock("@/observability");
describe("custom runtime template permission integration", () => {
  const ctx = useTemplateRouteTestApp();
  beforeEach(async () => {
    await ctx.app.register(agentRoutes);
    vi.spyOn(agentSandboxApi, "isInstalled", "get").mockReturnValue(true);
  });
  test.for([
    false,
    true,
  ])("template resolution, creation and ordinary edits (%s)", async (allowed, {
    makeCustomRole,
    makeMember,
    makeAgent,
    makeUser,
  }) => {
    ctx.member = await makeUser();
    const template = makeTemplate();
    await AgentRuntimeTemplateModel.saveSettings({
      organizationId: ctx.organizationId,
      settings: { revision: 0, templates: [template] },
      popularAgentOverrides: null,
    });
    const role = await makeCustomRole(ctx.organizationId, {
      permission: {
        agent: [
          "read",
          "create",
          ...(allowed ? ["configure-runtime" as const] : []),
        ],
      },
    });
    await makeMember(ctx.member.id, ctx.organizationId, { role: role.role });
    ctx.caller = ctx.member;
    const resolved = await ctx.app.inject({
      url: `/api/agent-runtime-templates/${template.id}`,
    });
    expect(resolved.statusCode, resolved.body).toBe(allowed ? 200 : 403);
    if (allowed) expect(resolved.json().runtime).toEqual(template.runtime);
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: "Template worker",
        agentType: "agent",
        runtime: template.runtime,
      },
    });
    expect(created.statusCode, created.body).toBe(allowed ? 200 : 403);
    const saved = await makeAgent({
      name: "Existing worker",
      organizationId: ctx.organizationId,
      authorId: ctx.member.id,
      agentType: "agent",
      runtime: template.runtime,
    });
    const edited = await ctx.app.inject({
      method: "PUT",
      url: `/api/agents/${saved.id}`,
      payload: { name: "Renamed worker" },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const actual = await AgentModel.findById(saved.id);
    expect(actual?.name).toBe("Renamed worker");
    expect(actual?.runtime).toEqual(template.runtime);
  });
});
