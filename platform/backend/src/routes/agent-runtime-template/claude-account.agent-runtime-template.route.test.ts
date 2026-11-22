import { vi } from "vitest";
import { agentSandboxApi } from "@/k8s/agent-runtime/sandbox-api";
import agentRoutes from "@/routes/agent";
import { beforeEach, describe, expect, test } from "@/test";
import {
  grantRuntime,
  makeTemplate,
  useTemplateRouteTestApp,
} from "./runtime-template.test-data";

vi.mock("@/observability");

// A custom runtime that runs Claude Code chooses whose Claude account runs it,
// as the built-in Claude Code runtime does.
describe("a custom runtime's Claude account", () => {
  const ctx = useTemplateRouteTestApp();
  beforeEach(async ({ makeUser, makeCustomRole, makeMember }) => {
    await ctx.app.register(agentRoutes);
    vi.spyOn(agentSandboxApi, "isInstalled", "get").mockReturnValue(true);
    ctx.member = await makeUser();
    const role = await makeCustomRole(ctx.organizationId, {
      permission: { agent: ["read", "create"] },
    });
    await makeMember(ctx.member.id, ctx.organizationId, { role: role.role });
  });

  const claudeTemplate = (authentication: "provider" | "subscription") => {
    const base = makeTemplate();
    return makeTemplate({
      runtime: {
        ...base.runtime,
        command: ["archestra-claude-code"],
        inferenceProtocol: "anthropic",
        claudeCode: { authentication, model: "opus" },
      },
    });
  };
  const saveSettings = (templates: ReturnType<typeof makeTemplate>[]) =>
    ctx.app.inject({
      method: "PUT",
      url: "/api/agent-runtime-templates/settings",
      payload: { revision: 0, templates, popularAgentOverrides: null },
    });

  test("is saved and read back by the editor, and the create-agent catalog resolves it", async () => {
    const template = claudeTemplate("provider");
    const saved = await saveSettings([template]);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().templates[0].runtime.claudeCode).toEqual({
      authentication: "provider",
      model: "opus",
    });

    const editor = await ctx.app.inject({
      url: "/api/agent-runtime-templates/settings",
    });
    expect(editor.json().templates[0].runtime.claudeCode).toEqual({
      authentication: "provider",
      model: "opus",
    });

    await grantRuntime({
      organizationId: ctx.organizationId,
      scope: template.id,
      userId: ctx.member.id,
      actions: ["read", "use"],
    });
    ctx.caller = ctx.member;
    const listed = await ctx.app.inject({
      url: "/api/agent-runtime-templates",
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().map((item: { id: string }) => item.id)).toEqual([
      template.id,
    ]);
    const resolved = await ctx.app.inject({
      url: `/api/agent-runtime-templates/${template.id}`,
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(resolved.json().runtime.claudeCode).toEqual({
      authentication: "provider",
      model: "opus",
    });
  });

  test("a runtime saved without a Claude account still loads, lists and resolves", async () => {
    const template = makeTemplate({
      runtime: { ...makeTemplate().runtime, inferenceProtocol: "anthropic" },
    });
    expect((await saveSettings([template])).statusCode).toBe(200);
    await grantRuntime({
      organizationId: ctx.organizationId,
      scope: template.id,
      userId: ctx.member.id,
      actions: ["read", "use"],
    });
    ctx.caller = ctx.member;
    const resolved = await ctx.app.inject({
      url: `/api/agent-runtime-templates/${template.id}`,
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(resolved.json().runtime).not.toHaveProperty("claudeCode");
  });

  test.for([
    "provider",
    "subscription",
  ] as const)("starts the agent of a builder who may use but not configure it on the runtime's account, and leaves them the one they name (%s)", async (authentication) => {
    const template = claudeTemplate(authentication);
    expect((await saveSettings([template])).statusCode).toBe(200);
    await grantRuntime({
      organizationId: ctx.organizationId,
      scope: template.id,
      userId: ctx.member.id,
      actions: ["read", "use"],
    });
    ctx.caller = ctx.member;
    const create = (runtime: object) =>
      ctx.app.inject({
        method: "POST",
        url: "/api/agents",
        payload: { agentType: "agent", name: "Worker", runtime },
      });
    const other = authentication === "provider" ? "subscription" : "provider";

    const named = await create({
      ...template.runtime,
      claudeCode: { authentication: other, model: "sonnet" },
    });
    const { claudeCode: _, ...unnamed } = template.runtime;
    const started = await create(unnamed);

    // The runtime's account is no rule: the one they name is stored as sent.
    expect(named.statusCode, named.body).toBe(200);
    expect(named.json().runtime.claudeCode).toEqual({
      authentication: other,
      model: "sonnet",
    });
    // An agent that names none starts on the runtime's.
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json().runtime.claudeCode).toEqual({
      authentication,
      model: "opus",
    });
  });
});
