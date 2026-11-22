// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  agentRuntimePermissionScope,
  buildAgentCatalogRuntime,
  DEFAULT_CLAUDE_CODE_MODEL,
} from "@archestra/shared";
import { vi } from "vitest";
import config from "@/config";
import { agentSandboxApi } from "@/k8s/agent-runtime/sandbox-api";
import AgentModel from "@/models/agent";
import AgentRuntimeTemplateModel from "@/models/agent-runtime-template";
import { makeKeyWithModel } from "@/routes/agent-runtime/agent-runtime-account.test-helpers";
import { beforeEach, describe, expect, test } from "@/test";
import { grantRoleEverywhere } from "@/test/wildcard-grants";
import type { AgentRuntime } from "@/types";
import agentRoutes from "../agent";
import {
  grantRuntime,
  makeTemplate,
  useTemplateRouteTestApp,
} from "./runtime-template.test-data";

vi.mock("@/observability");

const NOT_THEIRS_TO_LOCK = (runtime: string) =>
  `Only people who can configure the ${runtime} runtime can lock the account of its agents.`;

describe("whose choice an agent's account is, by its runtime's settings", () => {
  const ctx = useTemplateRouteTestApp();
  // A custom runtime that sets no Claude account leaves it to each agent.
  const open = makeTemplate({
    name: "Open workspace",
    runtime: {
      ...makeTemplate().runtime,
      image: "example.com/open-workspace:latest",
      inferenceProtocol: "anthropic",
    },
  });
  // A custom runtime whose settings store a Claude account and no account
  // rule: new agents start on it, and it restricts nothing.
  const company = makeTemplate({
    name: "Company workspace",
    position: 2,
    runtime: {
      ...makeTemplate().runtime,
      image: "example.com/company-workspace:latest",
      inferenceProtocol: "anthropic",
      claudeCode: { authentication: "provider" },
    },
  });
  // A custom runtime whose account rule names the company key.
  const ruled = makeTemplate({
    name: "Ruled workspace",
    position: 3,
    runtime: {
      ...makeTemplate().runtime,
      image: "example.com/ruled-workspace:latest",
      inferenceProtocol: "anthropic",
      claudeCode: { authentication: "provider" },
    },
    accounts: { kind: "key" },
  });
  const claudeCode = (): AgentRuntime =>
    buildAgentCatalogRuntime({
      id: "claude-code",
      image: config.agentRuntime.catalogImages["claude-code"],
    });
  let anthropic: Awaited<ReturnType<typeof makeKeyWithModel>>;

  beforeEach(async ({ makeUser, makeCustomRole, makeMember }) => {
    await ctx.app.register(agentRoutes);
    vi.spyOn(agentSandboxApi, "isInstalled", "get").mockReturnValue(true);
    await AgentRuntimeTemplateModel.saveSettings({
      organizationId: ctx.organizationId,
      settings: { revision: 0, templates: [open, company, ruled] },
      popularAgentOverrides: null,
    });
    // An agent builder who may use the runtimes but not configure them.
    ctx.member = await makeUser();
    const role = await makeCustomRole(ctx.organizationId, {
      permission: {
        agent: ["read", "create", "update"],
        llmProviderApiKey: ["read"],
      },
    });
    await makeMember(ctx.member.id, ctx.organizationId, { role: role.role });
    await grantRoleEverywhere({
      organizationId: ctx.organizationId,
      resource: "agent",
      roleId: role.id,
      actions: ["read", "use", "update"],
    });
    await grantRoleEverywhere({
      organizationId: ctx.organizationId,
      resource: "llmProviderApiKey",
      roleId: role.id,
      actions: ["read", "use"],
    });
    for (const scope of [
      open.id,
      company.id,
      ruled.id,
      agentRuntimePermissionScope({ kind: "built-in", id: "claude-code" }),
      agentRuntimePermissionScope({ kind: "built-in", id: "codex" }),
    ]) {
      await grantRuntime({
        organizationId: ctx.organizationId,
        scope,
        userId: ctx.member.id,
        actions: ["read", "use"],
      });
    }
    anthropic = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
  });

  const account = () => ({
    llmApiKeyId: anthropic.key.id,
    modelId: anthropic.model.id,
  });
  const create = (body: object) =>
    ctx.app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { agentType: "agent", name: "Worker", ...account(), ...body },
    });
  const update = (id: string, body: object) =>
    ctx.app.inject({ method: "PUT", url: `/api/agents/${id}`, payload: body });
  const copy = (id: string) =>
    ctx.app.inject({
      method: "POST",
      url: `/api/agents/${id}/clone`,
      payload: {},
    });
  const stored = async (id: string) => (await AgentModel.findById(id))?.runtime;

  /** An administrator saves the maintained runtimes' settings. */
  const saveBuiltIns = async (builtIns: object) => {
    ctx.caller = ctx.admin;
    const current = await AgentRuntimeTemplateModel.getSettings(
      ctx.organizationId,
    );
    return ctx.app.inject({
      method: "PUT",
      url: "/api/agent-runtime-templates/settings",
      payload: { ...current, builtIns },
    });
  };
  /**
   * The maintained Claude Code runtime's settings store a Claude account and
   * no rule, as they were saved before a runtime could carry one.
   */
  const nameClaudeCodeAccount = async (
    authentication: "provider" | "subscription",
  ) => {
    const saved = await saveBuiltIns({
      "claude-code": { settings: { claudeCode: { authentication } } },
    });
    expect(saved.statusCode, saved.body).toBe(200);
  };

  // The three accounts someone building an agent can give it.
  const eachPersonChooses = (base: AgentRuntime) => ({
    runtime: { ...base, accountLock: null },
    stored: { accountLock: null },
  });
  const companyKeyOnly = (base: AgentRuntime) => ({
    runtime: {
      ...base,
      claudeCode: { authentication: "provider" },
      accountLock: "key",
    },
    stored: { claudeCode: { authentication: "provider" }, accountLock: "key" },
  });
  const subscriptionOnly = (base: AgentRuntime) => ({
    runtime: {
      ...base,
      claudeCode: { authentication: "subscription" },
      accountLock: "subscription",
    },
    stored: {
      claudeCode: { authentication: "subscription" },
      accountLock: "subscription",
    },
  });

  /**
   * Someone who may only use the runtime gives a new agent each account, moves
   * an agent between them, and is held to the lock-fit rule a configurer is.
   */
  const builderChoosesTheAccount = async (base: AgentRuntime) => {
    ctx.caller = ctx.member;
    for (const choice of [
      eachPersonChooses,
      companyKeyOnly,
      subscriptionOnly,
    ]) {
      const created = await create({ runtime: choice(base).runtime });
      expect(created.statusCode, created.body).toBe(200);
      expect(await stored(created.json().id)).toMatchObject(
        choice(base).stored,
      );
    }

    const first = await create({ runtime: eachPersonChooses(base).runtime });
    const id = first.json().id as string;
    for (const choice of [
      companyKeyOnly,
      subscriptionOnly,
      eachPersonChooses,
    ]) {
      const updated = await update(id, { runtime: choice(base).runtime });
      expect(updated.statusCode, updated.body).toBe(200);
      expect(await stored(id)).toMatchObject(choice(base).stored);
    }

    const unfit = await update(id, {
      runtime: {
        ...base,
        claudeCode: { authentication: "provider" },
        accountLock: "subscription",
      },
    });
    expect(unfit.statusCode, unfit.body).toBe(400);
    expect(unfit.json().error.message).toBe(
      "To lock this agent to each person's own subscription, its own account must be a personal subscription.",
    );
    expect(await stored(id)).toMatchObject({ accountLock: null });
  };

  test("on a custom runtime that sets no Claude account, someone who may only use it chooses the agent's account", async () => {
    await builderChoosesTheAccount(open.runtime);
  });

  test("on the Claude Code runtime with no account named in its settings, someone who may only use it chooses the agent's account", async () => {
    // Nothing is stored for the runtime: the catalog's subscription only
    // starts a new agent, and restricts nothing.
    await builderChoosesTheAccount(claudeCode());

    // An agent that names no Claude account starts from the catalog's.
    const { claudeCode: _, ...unnamed } = claudeCode();
    const started = await create({ runtime: unnamed });
    expect(started.statusCode, started.body).toBe(200);
    expect(await stored(started.json().id)).toMatchObject({
      claudeCode: {
        authentication: "subscription",
        model: DEFAULT_CLAUDE_CODE_MODEL,
      },
      accountLock: null,
    });
  });

  test("a Claude account a runtime's settings store without an account rule leaves the agent's account to whoever builds it", async () => {
    // It only starts new agents: a builder who may only use the runtime
    // names the other account, and any lock, like on a runtime storing none.
    await builderChoosesTheAccount(company.runtime);
    for (const authentication of ["provider", "subscription"] as const) {
      await nameClaudeCodeAccount(authentication);
      await builderChoosesTheAccount(claudeCode());
    }
  });

  test("a copy starts as a new agent of the copier's on that runtime would", async () => {
    ctx.caller = ctx.admin;
    const sources = {
      open: await create({ runtime: companyKeyOnly(open.runtime).runtime }),
      claudeCode: await create({
        runtime: companyKeyOnly(claudeCode()).runtime,
      }),
      company: await create({
        runtime: { ...company.runtime, accountLock: "key" },
      }),
      ruled: await create({
        runtime: { ...ruled.runtime, accountLock: null },
      }),
    };
    for (const source of Object.values(sources)) {
      expect(source.statusCode, source.body).toBe(200);
    }

    ctx.caller = ctx.member;
    const copyOf = async (source: (typeof sources)["open"]) => {
      const copied = await copy(source.json().id);
      expect(copied.statusCode, copied.body).toBe(200);
      return stored(copied.json().id);
    };

    // The source's lock is never copied; the account is the copier's to
    // choose where the runtime's rule names no kind, a Claude account its
    // settings store or not.
    expect(await copyOf(sources.open)).toMatchObject({ accountLock: null });
    for (const source of [sources.claudeCode, sources.company]) {
      expect(await copyOf(source)).toMatchObject({
        claudeCode: { authentication: "provider" },
        accountLock: null,
      });
    }
    // Where it names one, the copy stores none either: the rule holds for
    // the copy's runs, and is written on no agent.
    expect(await copyOf(sources.ruled)).toMatchObject({
      claudeCode: { authentication: "provider" },
      accountLock: null,
    });
  });

  test("an agent moved onto a runtime keeps its own account: the runtime's rule is written on none", async () => {
    ctx.caller = ctx.member;
    // On the runtime whose rule names the company key, their agent stores
    // no lock: the rule is what holds its runs.
    const onRuled = async () => {
      const created = await create({ runtime: ruled.runtime });
      expect(created.statusCode, created.body).toBe(200);
      expect(await stored(created.json().id)).toMatchObject({
        accountLock: null,
      });
      return created.json().id as string;
    };

    // Onto a runtime whose rule names no kind, a Claude account its settings
    // store or not: theirs to choose.
    for (const destination of [open.runtime, company.runtime, claudeCode()]) {
      for (const choice of [
        eachPersonChooses,
        companyKeyOnly,
        subscriptionOnly,
      ]) {
        const id = await onRuled();
        const moved = await update(id, {
          runtime: choice(destination).runtime,
        });
        expect(moved.statusCode, moved.body).toBe(200);
        expect(await stored(id)).toMatchObject({
          image: destination.image,
          ...choice(destination).stored,
        });
      }
    }

    // Onto the runtime whose rule names a kind: a lock is not theirs to
    // bring, and the agent stores the account it is given, not the rule's.
    const elsewhere = await create({
      runtime: subscriptionOnly(open.runtime).runtime,
    });
    const id = elsewhere.json().id as string;
    const refused = await update(id, {
      runtime: { ...ruled.runtime, accountLock: "subscription" },
    });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().error.message).toBe(
      NOT_THEIRS_TO_LOCK("Ruled workspace"),
    );
    const moved = await update(id, {
      runtime: {
        ...ruled.runtime,
        claudeCode: { authentication: "subscription" },
        accountLock: null,
      },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(await stored(id)).toMatchObject({
      image: ruled.runtime.image,
      claudeCode: { authentication: "subscription" },
      accountLock: null,
    });
  });

  test("a save by someone who may only use the runtime never changes the agent's own Claude account to the kind the rule names", async () => {
    ctx.caller = ctx.admin;
    const created = await create({
      runtime: {
        ...ruled.runtime,
        claudeCode: { authentication: "subscription" },
        accountLock: null,
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().id as string;

    ctx.caller = ctx.member;
    const edited = await update(id, {
      runtime: {
        ...(await stored(id)),
        environment: [{ key: "WORKSPACE", value: "docs" }],
      },
    });

    expect(edited.statusCode, edited.body).toBe(200);
    expect(await stored(id)).toMatchObject({
      environment: [{ key: "WORKSPACE", value: "docs" }],
      claudeCode: { authentication: "subscription" },
      accountLock: null,
    });
  });

  test("applying the settings of the Claude Code runtime never changes an agent's Claude account", async ({
    makeAgent,
  }) => {
    // Agents with each kind of account, one of them saved before agents
    // carried an account lock.
    const agents = await Promise.all(
      [
        { claudeCode: { authentication: "provider" }, accountLock: "key" },
        {
          claudeCode: { authentication: "subscription" },
          accountLock: "subscription",
        },
        { claudeCode: { authentication: "provider" }, accountLock: null },
        { claudeCode: { authentication: "provider" } },
      ].map((own, index) =>
        makeAgent({
          organizationId: ctx.organizationId,
          agentType: "agent",
          name: `Claude worker ${index}`,
          ...account(),
          // With the tier fields a save through the runtime stores.
          runtime: {
            ...claudeCode(),
            tier: null,
            maxTier: null,
            ...own,
          } as AgentRuntime,
        }),
      ),
    );
    const before = await Promise.all(agents.map(({ id }) => stored(id)));
    const behind = async () =>
      (
        await ctx.app.inject({
          method: "GET",
          url: "/api/agent-runtime-templates/claude-code/apply-to-agents",
        })
      ).json().agents;
    const apply = () =>
      ctx.app.inject({
        method: "POST",
        url: "/api/agent-runtime-templates/claude-code/apply-to-agents",
      });

    // With nothing stored for the runtime, none of its agents is behind it.
    ctx.caller = ctx.admin;
    expect(await behind()).toBe(0);

    // Its other settings still apply, to every agent, account untouched.
    const saved = await saveBuiltIns({
      "claude-code": { settings: { ttlHours: 6 } },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(await behind()).toBe(agents.length);
    const applied = await apply();
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json()).toEqual({ updated: agents.length });
    expect(await Promise.all(agents.map(({ id }) => stored(id)))).toEqual(
      before.map((runtime) => ({ ...runtime, ttlHours: 6 })),
    );
    expect(await behind()).toBe(0);

    // A Claude account its settings store only starts new agents: the three
    // agents on the other account are not behind it, and applying leaves
    // them on their own.
    const single = await saveBuiltIns({
      "claude-code": {
        settings: {
          ttlHours: 6,
          claudeCode: { authentication: "subscription" },
        },
      },
    });
    expect(single.statusCode, single.body).toBe(200);
    expect(await behind()).toBe(0);
    const again = await apply();
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toEqual({ updated: 0 });
    expect(await Promise.all(agents.map(({ id }) => stored(id)))).toEqual(
      before.map((runtime) => ({ ...runtime, ttlHours: 6 })),
    );
  });

  test("a save ignores an account lock named on a runtime's settings, wherever it is named", async () => {
    // A lock is each agent's own. Neither a maintained runtime's settings
    // nor a custom runtime's hold one: it is dropped, not stored.
    ctx.caller = ctx.admin;
    const current = await AgentRuntimeTemplateModel.getSettings(
      ctx.organizationId,
    );
    const saved = await ctx.app.inject({
      method: "PUT",
      url: "/api/agent-runtime-templates/settings",
      payload: {
        ...current,
        templates: [
          { ...open, runtime: { ...open.runtime, accountLock: null } },
          { ...company, runtime: { ...company.runtime, accountLock: "key" } },
        ],
        builtIns: {
          "claude-code": { settings: { accountLock: null } },
          codex: { settings: { accountLock: "key" } },
        },
      },
    });

    expect(saved.statusCode, saved.body).toBe(200);
    const stored = await AgentRuntimeTemplateModel.getSettings(
      ctx.organizationId,
    );
    expect(stored.templates).toEqual([open, company]);
    expect(stored.builtIns).toEqual({
      "claude-code": { settings: {} },
      codex: { settings: {} },
    });
  });
});
