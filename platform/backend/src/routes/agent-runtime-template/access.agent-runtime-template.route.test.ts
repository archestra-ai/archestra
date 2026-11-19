// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  agentRuntimePermissionScope,
  buildAgentCatalogRuntime,
  buildCustomAgentRuntime,
} from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import { agentSandboxApi } from "@/k8s/agent-runtime/sandbox-api";
import AgentModel from "@/models/agent";
import AgentRuntimeTemplateModel from "@/models/agent-runtime-template";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import agentRoutes from "@/routes/agent";
import { beforeEach, describe, expect, test } from "@/test";
import { drainBackgroundWork } from "@/utils/background-work";
import {
  grantRuntime,
  makeTemplate,
  useTemplateRouteTestApp,
} from "./runtime-template.test-data";

vi.mock("@/observability");

describe("Agent Runtime permissions", () => {
  const ctx = useTemplateRouteTestApp();
  beforeEach(async ({ makeUser, makeCustomRole, makeMember }) => {
    await ctx.app.register(agentRoutes);
    vi.spyOn(agentSandboxApi, "isInstalled", "get").mockReturnValue(true);
    // An agent builder with no runtime grants of their own.
    ctx.member = await makeUser();
    const role = await makeCustomRole(ctx.organizationId, {
      permission: { agent: ["read", "create"] },
    });
    await makeMember(ctx.member.id, ctx.organizationId, { role: role.role });
  });

  const saveTemplates = (templates: ReturnType<typeof makeTemplate>[]) =>
    AgentRuntimeTemplateModel.saveSettings({
      organizationId: ctx.organizationId,
      settings: { revision: 0, templates },
      popularAgentOverrides: null,
    });
  const createAgent = (runtime: object) =>
    ctx.app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { agentType: "agent", name: "Worker", runtime },
    });

  test("use without configure gives a new agent the runtime's settings; configure keeps the caller's", async () => {
    const template = makeTemplate({
      runtime: { ...makeTemplate().runtime, ttlHours: 4 },
    });
    await saveTemplates([template]);
    const changed = {
      ...template.runtime,
      ttlHours: 12,
      environment: [{ key: "AGENT_OWN", value: "kept" }],
    };
    ctx.caller = ctx.member;

    expect((await createAgent(changed)).statusCode).toBe(403);

    await grantRuntime({
      organizationId: ctx.organizationId,
      scope: template.id,
      userId: ctx.member.id,
      actions: ["read", "use"],
    });
    const used = await createAgent(changed);
    expect(used.statusCode, used.body).toBe(200);
    expect(used.json().runtime).toMatchObject({
      ttlHours: 4,
      environment: [{ key: "AGENT_OWN", value: "kept" }],
    });

    await grantRuntime({
      organizationId: ctx.organizationId,
      scope: template.id,
      userId: ctx.member.id,
      actions: ["read", "use", "configure"],
    });
    const configured = await createAgent(changed);
    expect(configured.statusCode, configured.body).toBe(200);
    expect(configured.json().runtime.ttlHours).toBe(12);
  });

  test("using one runtime doesn't allow an image that is none of them", async () => {
    const template = makeTemplate();
    await saveTemplates([template]);
    await grantRuntime({
      organizationId: ctx.organizationId,
      scope: template.id,
      userId: ctx.member.id,
      actions: ["read", "use", "configure"],
    });
    ctx.caller = ctx.member;
    const refused = await createAgent(
      buildCustomAgentRuntime({ image: "registry.example.com/own:v1" }),
    );
    expect(refused.statusCode).toBe(403);
  });

  test("lists which runtimes the caller may use and configure", async () => {
    const template = makeTemplate();
    await saveTemplates([template]);
    await grantRuntime({
      organizationId: ctx.organizationId,
      scope: agentRuntimePermissionScope({ kind: "built-in", id: "codex" }),
      userId: ctx.member.id,
      actions: ["read", "use"],
    });
    ctx.caller = ctx.member;
    const response = await ctx.app.inject({
      url: "/api/agent-runtime-templates/access",
    });
    expect(response.statusCode, response.body).toBe(200);
    const { runtimes, canConfigureAny } = response.json();
    expect(canConfigureAny).toBe(false);
    expect(runtimes).toContainEqual({
      id: "codex",
      canUse: true,
      canConfigure: false,
    });
    expect(runtimes).toContainEqual({
      id: template.id,
      canUse: false,
      canConfigure: false,
    });

    ctx.caller = ctx.admin;
    const admin = await ctx.app.inject({
      url: "/api/agent-runtime-templates/access",
    });
    expect(admin.json().canConfigureAny).toBe(true);
  });

  test("applies a runtime's settings to its existing agents and audits it", async ({
    makeAgent,
  }) => {
    const template = makeTemplate();
    const ownEnvironment = [{ key: "AGENT_OWN", value: "kept" }];
    const follower = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      runtime: { ...template.runtime, environment: ownEnvironment },
    });
    const other = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      runtime: buildCustomAgentRuntime({
        image: "registry.example.com/other:v1",
      }),
    });
    await saveTemplates([
      {
        ...template,
        runtime: { ...template.runtime, ttlHours: 4, steerMode: "tmux_keys" },
      },
    ]);
    // Saving settings only starts new agents.
    expect((await AgentModel.findById(follower.id))?.runtime?.ttlHours).toBe(
      null,
    );
    const apply = () =>
      ctx.app.inject({
        method: "POST",
        url: `/api/agent-runtime-templates/${template.id}/apply-to-agents`,
      });

    ctx.caller = ctx.member;
    expect((await apply()).statusCode).toBe(403);

    ctx.caller = ctx.admin;
    const applied = await apply();
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json()).toEqual({ updated: 1 });
    expect((await AgentModel.findById(follower.id))?.runtime).toMatchObject({
      ttlHours: 4,
      steerMode: "tmux_keys",
      environment: ownEnvironment,
    });
    expect((await AgentModel.findById(other.id))?.runtime).toEqual(
      other.runtime,
    );

    await drainBackgroundWork();
    const [audit] = await db
      .select()
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.organizationId, ctx.organizationId),
          eq(
            schema.auditLogsTable.httpRoute,
            "/api/agent-runtime-templates/:id/apply-to-agents",
          ),
          eq(schema.auditLogsTable.outcome, "success"),
        ),
      );
    expect(audit).toMatchObject({
      action: "organization.updated",
      before: {
        runtime: template.name,
        agentsOnOtherSettings: [follower.name],
      },
      after: { runtime: template.name, agentsOnOtherSettings: [] },
    });

    expect((await apply()).json()).toEqual({ updated: 0 });
  });

  test("applies a built-in runtime's settings to its agents", async ({
    makeAgent,
  }) => {
    const codex = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      runtime: buildAgentCatalogRuntime({
        id: "codex",
        image: config.agentRuntime.catalogImages.codex,
      }),
    });
    await AgentRuntimeTemplateModel.saveSettings({
      organizationId: ctx.organizationId,
      settings: {
        revision: 0,
        templates: [],
        builtIns: { codex: { settings: { ttlHours: 6, maxCostUsd: 20 } } },
      },
      popularAgentOverrides: null,
    });
    const applied = await ctx.app.inject({
      method: "POST",
      url: "/api/agent-runtime-templates/codex/apply-to-agents",
    });
    expect(applied.statusCode, applied.body).toBe(200);
    expect((await AgentModel.findById(codex.id))?.runtime).toMatchObject({
      ttlHours: 6,
      maxCostUsd: 20,
    });
  });

  test("refuses a new custom runtime on a maintained or another runtime's image", async () => {
    const save = (templates: ReturnType<typeof makeTemplate>[]) =>
      ctx.app.inject({
        method: "PUT",
        url: "/api/agent-runtime-templates/settings",
        payload: { revision: 0, templates, popularAgentOverrides: null },
      });
    const maintained = await save([
      makeTemplate({
        runtime: {
          ...buildCustomAgentRuntime({
            image: config.agentRuntime.catalogImages.codex,
          }),
          privileged: false,
          environment: null,
        },
      }),
    ]);
    expect(maintained.statusCode).toBe(400);
    expect(maintained.body).toContain("maintained image");
    const twins = await save([
      makeTemplate(),
      makeTemplate({ name: "Same image" }),
    ]);
    expect(twins.statusCode).toBe(400);
    expect(twins.body).toContain("use the same image");
  });

  test("removing a custom runtime removes its permissions", async () => {
    const template = makeTemplate();
    const saved = await saveTemplates([template]);
    await grantRuntime({
      organizationId: ctx.organizationId,
      scope: template.id,
      userId: ctx.member.id,
      actions: ["read", "use"],
    });
    await AgentRuntimeTemplateModel.saveSettings({
      organizationId: ctx.organizationId,
      settings: { revision: saved.revision, templates: [] },
      popularAgentOverrides: null,
    });
    expect(
      await ResourcePermissionPolicyModel.find({
        organizationId: ctx.organizationId,
        resource: "agentRuntime",
        scope: template.id,
      }),
    ).toBeNull();
  });
});
