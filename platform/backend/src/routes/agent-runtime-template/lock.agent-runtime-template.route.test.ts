import {
  buildAgentCatalogRuntime,
  buildCustomAgentRuntime,
} from "@archestra/shared";
import config from "@/config";
import AgentModel from "@/models/agent";
import { describe, expect, test } from "@/test";
import {
  makeTemplate,
  useTemplateRouteTestApp,
} from "./runtime-template.test-data";

describe("locked Agent Runtime settings", () => {
  const ctx = useTemplateRouteTestApp();
  const save = (payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: "PUT",
      url: "/api/agent-runtime-templates/settings",
      payload: { popularAgentOverrides: null, ...payload },
    });

  test("a locked custom runtime's settings reach every agent of its type; unlocked ones only start new agents", async ({
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
    const limited = {
      ...template,
      runtime: { ...template.runtime, ttlHours: 4, steerMode: "tmux_keys" },
    };

    expect((await save({ revision: 0, templates: [limited] })).statusCode).toBe(
      200,
    );
    expect((await AgentModel.findById(follower.id))?.runtime?.ttlHours).toBe(
      null,
    );

    const locked = await save({
      revision: 1,
      templates: [{ ...limited, locked: true }],
    });
    expect(locked.statusCode, locked.body).toBe(200);
    expect((await AgentModel.findById(follower.id))?.runtime).toMatchObject({
      ttlHours: 4,
      steerMode: "tmux_keys",
      environment: ownEnvironment,
    });
    expect((await AgentModel.findById(other.id))?.runtime).toEqual(
      other.runtime,
    );
  });

  test("a locked maintained runtime's settings reach its agents, and any agent builder can read them", async ({
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
    const builtIns = {
      codex: { locked: true, settings: { ttlHours: 6, maxCostUsd: 20 } },
    };
    const saved = await save({ revision: 0, templates: [], builtIns });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await AgentModel.findById(codex.id))?.runtime).toMatchObject({
      ttlHours: 6,
      maxCostUsd: 20,
    });

    ctx.caller = ctx.member;
    expect(
      (await save({ revision: 1, templates: [], builtIns: {} })).statusCode,
    ).toBe(403);
    const read = await ctx.app.inject({
      method: "GET",
      url: "/api/agent-runtime-templates/built-ins",
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual([{ id: "codex", ...builtIns.codex }]);
  });

  test("changing a locked custom runtime's image moves its agents to the new image", async ({
    makeAgent,
  }) => {
    const template = makeTemplate({ locked: true });
    const agent = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      runtime: template.runtime,
    });
    expect(
      (await save({ revision: 0, templates: [template] })).statusCode,
    ).toBe(200);
    const moved = {
      ...template,
      runtime: { ...template.runtime, image: "registry.example.com/agent:v2" },
    };
    expect((await save({ revision: 1, templates: [moved] })).statusCode).toBe(
      200,
    );
    expect((await AgentModel.findById(agent.id))?.runtime?.image).toBe(
      "registry.example.com/agent:v2",
    );
  });

  test("a custom runtime with a maintained image can't be locked", async () => {
    const template = makeTemplate({
      locked: true,
      runtime: {
        ...buildCustomAgentRuntime({
          image: config.agentRuntime.catalogImages.codex,
        }),
        privileged: false,
      },
    });
    const refused = await save({ revision: 0, templates: [template] });
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toContain("Lock the built-in runtime instead");
  });

  test("a locked runtime's image can't be shared with another custom runtime", async () => {
    const template = makeTemplate({ locked: true });
    const twin = makeTemplate({ name: "Same image" });
    const refused = await save({ revision: 0, templates: [template, twin] });
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toContain("locked runtime's image");
  });
});
