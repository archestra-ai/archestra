// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { buildAgentCatalogRuntime } from "@archestra/shared";
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
  makeTemplate,
  useTemplateRouteTestApp,
} from "./runtime-template.test-data";

vi.mock("@/observability");

const NOT_THEIRS_TO_LOCK =
  "Only an administrator can lock the account of this agent.";

describe("whose choice an agent's account is, by its runtime's settings", () => {
  const ctx = useTemplateRouteTestApp();
  // Custom images that run Claude Code: their command is the maintained
  // Claude Code one, so their agents can run on each person's Claude
  // subscription or on a company API key.
  // One that sets no Claude account leaves it to each agent.
  const open = makeTemplate({
    name: "Open workspace",
    runtime: {
      ...makeTemplate().runtime,
      image: "example.com/open-workspace:latest",
      command: ["archestra-claude-code"],
      inferenceProtocol: "anthropic",
    },
  });
  // One whose settings store a Claude account and no account rule: new
  // agents start on it, and it restricts nothing.
  const company = makeTemplate({
    name: "Company workspace",
    position: 2,
    runtime: {
      ...makeTemplate().runtime,
      image: "example.com/company-workspace:latest",
      command: ["archestra-claude-code"],
      inferenceProtocol: "anthropic",
      claudeCode: { authentication: "provider" },
    },
  });
  // One whose account rule names the company key.
  const ruled = makeTemplate({
    name: "Ruled workspace",
    position: 3,
    runtime: {
      ...makeTemplate().runtime,
      image: "example.com/ruled-workspace:latest",
      command: ["archestra-claude-code"],
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
    // An agent builder who may configure an agent's runtime, not the
    // organization's settings.
    ctx.member = await makeUser();
    const role = await makeCustomRole(ctx.organizationId, {
      permission: {
        agent: ["read", "create", "update", "configure-runtime"],
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
      "claude-code": {
        locked: false,
        settings: { claudeCode: { authentication } },
      },
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
   * A builder gives a new agent each account, moves an agent between them,
   * and is held to the lock-fit rule an administrator is.
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

  test("on a custom runtime that sets no Claude account, a builder chooses the agent's account", async () => {
    await builderChoosesTheAccount(open.runtime);
  });

  test("on the Claude Code runtime with no account named in its settings, a builder chooses the agent's account", async () => {
    // Nothing is stored for the runtime: the catalog's subscription restricts
    // nothing.
    await builderChoosesTheAccount(claudeCode());
  });

  test("a Claude account a runtime's settings store without an account rule leaves the agent's account to whoever builds it", async () => {
    // It restricts nothing on a runtime that is not locked: a builder names
    // the other account, and any lock, like on a runtime storing none.
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

    // Onto the runtime whose rule names a kind: a lock is not theirs to set
    // or to bring there, and the agent stores the account it is given, not
    // the rule's.
    const elsewhere = await create({
      runtime: eachPersonChooses(open.runtime).runtime,
    });
    const id = elsewhere.json().id as string;
    const refused = await update(id, {
      runtime: {
        ...ruled.runtime,
        claudeCode: { authentication: "subscription" },
        accountLock: "subscription",
      },
    });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().error.message).toBe(NOT_THEIRS_TO_LOCK);
    const locked = await create({
      runtime: subscriptionOnly(open.runtime).runtime,
    });
    expect(locked.statusCode, locked.body).toBe(200);
    const carried = await update(locked.json().id as string, {
      runtime: { ...ruled.runtime, accountLock: "subscription" },
    });
    expect(carried.statusCode, carried.body).toBe(403);
    expect(carried.json().error.message).toBe(NOT_THEIRS_TO_LOCK);
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

  test("a builder's save never changes the agent's own Claude account to the kind the rule names", async () => {
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
          "claude-code": { locked: false, settings: { accountLock: null } },
          codex: { locked: false, settings: { accountLock: "key" } },
        },
      },
    });

    expect(saved.statusCode, saved.body).toBe(200);
    const stored = await AgentRuntimeTemplateModel.getSettings(
      ctx.organizationId,
    );
    expect(stored.templates).toEqual([open, company]);
    expect(stored.builtIns).toEqual({
      "claude-code": { locked: false, settings: {} },
      codex: { locked: false, settings: {} },
    });
  });
});
