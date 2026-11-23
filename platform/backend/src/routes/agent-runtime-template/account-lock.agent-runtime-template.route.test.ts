// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  ARCHESTRA_MCP_SERVER_NAME,
  agentRuntimePermissionScope,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  resolveAgentRuntimeTiers,
} from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import { assert, vi } from "vitest";
import { executeArchestraTool } from "@/archestra-mcp-server";
import config from "@/config";
import db, { schema } from "@/database";
import { agentSandboxApi } from "@/k8s/agent-runtime/sandbox-api";
import { AgentRuntimeUserAccountModel, VirtualApiKeyModel } from "@/models";
import AgentModel from "@/models/agent";
import AgentRuntimeTemplateModel from "@/models/agent-runtime-template";
import AgentVersionModel from "@/models/agent-version";
import { makeKeyWithModel } from "@/routes/agent-runtime/agent-runtime-account.test-helpers";
import { assertAccountLockWrite } from "@/services/agent-runtime/agent-runtime-access";
import { buildAgentRunLaunchSpec } from "@/services/agent-runtime/launch-spec";
import { resolveAgentRuntime } from "@/services/agent-runtime/pod-run";
import { preflightAgentRuntimeModelReadiness } from "@/services/agent-runtime/preflight";
import { resolveAgentRunLimits } from "@/services/agent-runtime/runtime-tiers";
import { beforeEach, describe, expect, test } from "@/test";
import { grantRoleEverywhere } from "@/test/wildcard-grants";
import type { AgentRuntime, User } from "@/types";
import { drainBackgroundWork } from "@/utils/background-work";
import agentRoutes from "../agent";
import agentRuntimeRoutes from "../agent-runtime/agent-runtime.routes";
import {
  grantRuntime,
  makeTemplate,
  useTemplateRouteTestApp,
} from "./runtime-template.test-data";

vi.mock("@/observability");

const TIERS = resolveAgentRuntimeTiers(null, { defaultWarmSpares: 0 });

describe("an agent's account lock", () => {
  const ctx = useTemplateRouteTestApp();
  // A runtime whose settings store a Claude account and no account rule:
  // whoever may put agents on it chooses their account, the lock included.
  const template = makeTemplate({
    runtime: {
      ...makeTemplate().runtime,
      inferenceProtocol: "openai_chat",
      claudeCode: { authentication: "provider" },
    },
  });
  let own: Awaited<ReturnType<typeof makeKeyWithModel>>;
  let other: Awaited<ReturnType<typeof makeKeyWithModel>>;
  /** Someone who can edit every agent and may not use the runtime. */
  let editor: User;

  beforeEach(async ({ makeUser, makeCustomRole, makeMember }) => {
    await ctx.app.register(agentRoutes);
    vi.spyOn(agentSandboxApi, "isInstalled", "get").mockReturnValue(true);
    await AgentRuntimeTemplateModel.saveSettings({
      organizationId: ctx.organizationId,
      settings: { revision: 0, templates: [template] },
      popularAgentOverrides: null,
    });
    // An agent builder who may use the runtime but not configure it.
    ctx.member = await makeUser();
    const role = await makeCustomRole(ctx.organizationId, {
      permission: {
        agent: ["read", "create", "update"],
        llmProviderApiKey: ["read"],
      },
    });
    await makeMember(ctx.member.id, ctx.organizationId, { role: role.role });
    editor = await makeUser();
    await makeMember(editor.id, ctx.organizationId, { role: role.role });
    // Every agent of the organization is theirs to edit.
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
    await grantRuntime({
      organizationId: ctx.organizationId,
      scope: template.id,
      userId: ctx.member.id,
      actions: ["read", "use"],
    });
    own = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4",
    });
    other = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4-mini",
    });
  });

  const runtime = (accountLock?: AgentRuntime["accountLock"]) => ({
    ...template.runtime,
    ...(accountLock !== undefined && { accountLock }),
  });

  const create = (body: object) =>
    ctx.app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { agentType: "agent", name: "Locked worker", ...body },
    });
  const update = (id: string, body: object) =>
    ctx.app.inject({ method: "PUT", url: `/api/agents/${id}`, payload: body });
  const stored = async (id: string) => (await AgentModel.findById(id))?.runtime;
  /**
   * The runtime's account rule names the company key (or, with none, is
   * cleared): under a named kind only its configurers choose a lock.
   */
  const nameAccountKind = async (kind: "key" | null) => {
    const current = await AgentRuntimeTemplateModel.getSettings(
      ctx.organizationId,
    );
    await AgentRuntimeTemplateModel.saveSettings({
      organizationId: ctx.organizationId,
      settings: {
        ...current,
        templates: [{ ...template, ...(kind && { accounts: { kind } }) }],
      },
      popularAgentOverrides: null,
    });
  };
  const NO_USE =
    "You don't have permission to use the Engineering workspace runtime.";

  /** The launch spec of a run of the agent by `userId`, as a run builds it. */
  const launchAs = async (id: string, userId: string) => {
    const agent = await AgentModel.findById(id);
    assert(agent);
    const resolved = resolveAgentRuntime(agent);
    assert(resolved);
    vi.spyOn(config.agentRuntime, "platformBaseUrl", "get").mockReturnValue(
      "https://platform.example.test",
    );
    return buildAgentRunLaunchSpec({
      runtime: resolved,
      limits: resolveAgentRunLimits({ runtime: resolved, tiers: TIERS }),
      taskId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      agentId: id,
      actor: { kind: "user", id: userId, organizationId: ctx.organizationId },
      organizationId: ctx.organizationId,
      runtimeScope: "agent-tests",
      effectiveNetworkPolicy: { source: "built_in", policy: null },
      appName: "Archestra",
      runMode: "one_shot",
    });
  };
  const boundKeyIds = async (run: { virtualApiKeyId?: string | null }) =>
    (
      await VirtualApiKeyModel.getProviderApiKeys(run.virtualApiKeyId as string)
    ).map((entry) => entry.providerApiKeyId);

  const lockedAgent = async () => {
    ctx.caller = ctx.admin;
    const response = await create({
      runtime: runtime("key"),
      llmApiKeyId: own.key.id,
      modelId: own.model.id,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().id as string;
  };

  test("where the runtime's rule names no kind, whoever may use it sets, changes and removes the lock", async () => {
    // The Claude account its settings store is not a rule.
    ctx.caller = ctx.member;
    const created = await create({
      runtime: runtime("key"),
      llmApiKeyId: own.key.id,
      modelId: own.model.id,
    });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().id as string;
    expect(await stored(id)).toMatchObject({ accountLock: "key" });

    // One an administrator set is theirs to change too.
    const lockedId = await lockedAgent();
    ctx.caller = ctx.member;
    for (const agentId of [id, lockedId]) {
      const unlocked = await update(agentId, { runtime: runtime(null) });
      expect(unlocked.statusCode, unlocked.body).toBe(200);
      expect(await stored(agentId)).toMatchObject({ accountLock: null });
      const relocked = await update(agentId, { runtime: runtime("key") });
      expect(relocked.statusCode, relocked.body).toBe(200);
      expect(await stored(agentId)).toMatchObject({ accountLock: "key" });
    }

    // Someone who may not use the runtime changes nothing of it.
    ctx.caller = editor;
    const refused = await update(id, { runtime: runtime(null) });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toBe(NO_USE);
    expect(await stored(id)).toMatchObject({ accountLock: "key" });
  });

  test("where the runtime's rule names a kind, only someone who can configure it sets another lock, changes or removes one", async () => {
    await nameAccountKind("key");
    ctx.caller = ctx.member;
    const refused = await create({
      runtime: runtime("subscription"),
      llmApiKeyId: own.key.id,
      modelId: own.model.id,
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toBe(
      "Only people who can configure the Engineering workspace runtime can lock the account of its agents.",
    );

    const id = await lockedAgent();
    expect(await stored(id)).toMatchObject({ accountLock: "key" });

    ctx.caller = ctx.member;
    for (const lock of ["subscription", null] as const) {
      const refusedChange = await update(id, { runtime: runtime(lock) });
      expect(refusedChange.statusCode).toBe(403);
      expect(refusedChange.json().error.message).toBe(
        "This agent's account is locked. Only people who can configure the Engineering workspace runtime can change or remove the lock.",
      );
    }
    expect(await stored(id)).toMatchObject({ accountLock: "key" });

    await grantRuntime({
      organizationId: ctx.organizationId,
      scope: template.id,
      userId: ctx.member.id,
      actions: ["read", "use", "configure"],
    });
    const unlocked = await update(id, { runtime: runtime(null) });
    expect(unlocked.statusCode, unlocked.body).toBe(200);
    // "Each person chooses" is stored, not left out: a runtime that names no
    // lock means something else.
    expect(await stored(id)).toMatchObject({ accountLock: null });
  });

  test("a new agent that names no lock is stored as each person chooses", async () => {
    ctx.caller = ctx.admin;
    const response = await create({
      runtime: runtime(),
      llmApiKeyId: own.key.id,
      modelId: own.model.id,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(await stored(response.json().id)).toMatchObject({
      accountLock: null,
    });
  });

  test("an agent put on a runtime that stores a Claude account and no rule, by someone who may only use it, lets each person choose", async () => {
    const claude = makeTemplate({
      name: "Claude workspace",
      position: 2,
      runtime: {
        ...makeTemplate().runtime,
        image: "example.com/claude-workspace:latest",
        command: ["claude-workspace"],
        inferenceProtocol: "anthropic",
        claudeCode: { authentication: "subscription" },
      },
    });
    const current = await AgentRuntimeTemplateModel.getSettings(
      ctx.organizationId,
    );
    await AgentRuntimeTemplateModel.saveSettings({
      organizationId: ctx.organizationId,
      settings: { ...current, templates: [template, claude] },
      popularAgentOverrides: null,
    });
    await grantRuntime({
      organizationId: ctx.organizationId,
      scope: claude.id,
      userId: ctx.member.id,
      actions: ["read", "use"],
    });

    ctx.caller = ctx.member;
    const response = await create({ runtime: claude.runtime });
    expect(response.statusCode, response.body).toBe(200);
    // Not stored without a lock, which would run only the one way.
    expect(await stored(response.json().id)).toMatchObject({
      claudeCode: { authentication: "subscription" },
      accountLock: null,
    });
  });

  test("an agent saved before people could choose keeps its one way until someone who chooses its account opens it", async ({
    makeAgent,
  }) => {
    // Stored as every agent was before the lock existed: no lock named.
    const [legacy, second] = await Promise.all(
      ["First", "Second"].map((name) =>
        makeAgent({
          organizationId: ctx.organizationId,
          agentType: "agent",
          name,
          runtime: runtime(),
          llmApiKeyId: own.key.id,
          modelId: own.model.id,
        }),
      ),
    );
    expect(await stored(legacy.id)).not.toHaveProperty("accountLock");

    ctx.caller = ctx.member;
    // An edit that does not name the lock leaves it as it was.
    expect((await update(legacy.id, { name: "Renamed" })).statusCode).toBe(200);
    expect((await update(legacy.id, { runtime: runtime() })).statusCode).toBe(
      200,
    );
    expect(await stored(legacy.id)).not.toHaveProperty("accountLock");

    // Under a rule that names a kind, that is the runtime's configurers.
    await nameAccountKind("key");
    const refused = await update(legacy.id, { runtime: runtime(null) });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toBe(
      "Only people who can configure the Engineering workspace runtime can let each person choose the account for its agents.",
    );
    expect(await stored(legacy.id)).not.toHaveProperty("accountLock");

    ctx.caller = ctx.admin;
    const opened = await update(legacy.id, { runtime: runtime(null) });
    expect(opened.statusCode, opened.body).toBe(200);
    expect(await stored(legacy.id)).toMatchObject({ accountLock: null });

    // With no rule, whoever may put agents on the runtime: the Claude
    // account its settings store does not keep the agent to one way.
    await nameAccountKind(null);
    ctx.caller = ctx.member;
    const theirs = await update(second.id, { runtime: runtime(null) });
    expect(theirs.statusCode, theirs.body).toBe(200);
    expect(await stored(second.id)).toMatchObject({ accountLock: null });
  });

  test("a locked agent keeps its lock through edits that leave its account alone", async () => {
    const id = await lockedAgent();
    ctx.caller = ctx.member;

    expect((await update(id, { name: "Renamed" })).statusCode).toBe(200);
    // A runtime that does not name the lock keeps it.
    const resaved = await update(id, { runtime: runtime() });
    expect(resaved.statusCode, resaved.body).toBe(200);
    expect(await stored(id)).toMatchObject({ accountLock: "key" });
  });

  test("a locked agent's account, runtime and removal are refused to someone who may not use its runtime", async ({
    makeAgent,
  }) => {
    const id = await lockedAgent();
    ctx.caller = editor;

    const account = await update(id, {
      llmApiKeyId: other.key.id,
      modelId: other.model.id,
    });
    expect(account.statusCode).toBe(403);
    expect(account.json().error.message).toBe(
      "This agent's account is locked. Only people who can configure the Engineering workspace runtime can change its account or runtime.",
    );
    const second = makeTemplate({
      name: "Second workspace",
      runtime: {
        ...template.runtime,
        image: "registry.example.com/other-agent:v1",
      },
    });
    await AgentRuntimeTemplateModel.saveSettings({
      organizationId: ctx.organizationId,
      settings: { revision: 1, templates: [template, second] },
      popularAgentOverrides: null,
    });
    for (const userId of [editor.id, ctx.member.id]) {
      await grantRuntime({
        organizationId: ctx.organizationId,
        scope: second.id,
        userId,
        actions: ["read", "use"],
      });
    }
    // Moving it or removing its runtime takes the runtime it is on.
    for (const moved of [{ ...second.runtime }, null]) {
      const refusedMove = await update(id, { runtime: moved });
      expect(refusedMove.statusCode).toBe(403);
      expect(refusedMove.json().error.message).toBe(NO_USE);
    }
    expect(await AgentModel.findById(id)).toMatchObject({
      llmApiKeyId: own.key.id,
      runtime: { image: template.runtime.image, accountLock: "key" },
    });

    // An unlocked agent's account stays the editor's to change.
    const plain = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: editor.id,
      agentType: "agent",
      runtime: runtime(),
    });
    const unlocked = await update(plain.id, {
      llmApiKeyId: other.key.id,
      modelId: other.model.id,
    });
    expect(unlocked.statusCode, unlocked.body).toBe(200);

    // Someone who may put agents on the runtime chooses the locked agent's
    // account too: its key and model, its runtime, and no runtime at all.
    ctx.caller = ctx.member;
    const changed = await update(id, {
      llmApiKeyId: other.key.id,
      modelId: other.model.id,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const movedAway = await update(id, { runtime: { ...second.runtime } });
    expect(movedAway.statusCode, movedAway.body).toBe(200);
    expect(await AgentModel.findById(id)).toMatchObject({
      llmApiKeyId: other.key.id,
      runtime: { image: second.runtime.image, accountLock: "key" },
    });
    expect((await update(id, { runtime: null })).statusCode).toBe(200);
    expect((await update(id, { runtime: runtime() })).statusCode).toBe(200);
    // A runtime added back is a new agent's: each person chooses.
    expect(await stored(id)).toMatchObject({ accountLock: null });
  });

  test("a configurer may change a locked agent's account when it still fits", async () => {
    const id = await lockedAgent();
    const changed = await update(id, {
      llmApiKeyId: other.key.id,
      modelId: other.model.id,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(await AgentModel.findById(id)).toMatchObject({
      llmApiKeyId: other.key.id,
      runtime: { accountLock: "key" },
    });
  });

  test("refuses a lock that does not fit the kind of the agent's own account", async () => {
    ctx.caller = ctx.admin;
    const subscription = await create({
      runtime: runtime("subscription"),
      llmApiKeyId: own.key.id,
      modelId: own.model.id,
    });
    expect(subscription.statusCode).toBe(400);
    expect(subscription.json().error.message).toContain(
      "its own account must be a personal subscription",
    );

    // A lock is one of the two kinds: any other value is refused.
    const anyCompanyKey = await create({
      runtime: { ...template.runtime, accountLock: "provider" },
      llmApiKeyId: own.key.id,
      modelId: own.model.id,
    });
    expect(anyCompanyKey.statusCode).toBe(400);
    expect(anyCompanyKey.json().error.message).toContain("accountLock");
  });

  test("a company API key with no connection, or a connection and no model, is saved under every lock, through the API and the MCP tool", async () => {
    ctx.caller = ctx.admin;
    // The maintained Codex runtime, by its wrapper command: both kinds of
    // account, so every lock fits it.
    const codex = {
      ...template.runtime,
      image: "registry.example.com/archestra-codex:v1",
      command: ["archestra-codex"],
    };
    const account = async (id: string) => {
      const agent = await AgentModel.findById(id);
      return {
        llmApiKeyId: agent?.llmApiKeyId,
        modelId: agent?.modelId,
        accountLock: agent?.runtime?.accountLock,
      };
    };
    const editThroughMcp = (id: string, args: object) =>
      executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}edit_agent`,
        { id, ...args },
        {
          agent: { id, name: "Locked worker" },
          userId: ctx.admin.id,
          organizationId: ctx.organizationId,
        },
      );

    for (const accountLock of [null, "key", "subscription"] as const) {
      const locked = { ...codex, accountLock };
      // What each person runs it on is theirs to choose, or the default.
      for (const card of [
        { llmApiKeyId: null, modelId: null },
        { llmApiKeyId: own.key.id, modelId: null },
      ]) {
        const created = await create({
          name: `Codex ${accountLock} ${card.llmApiKeyId ? "key" : "empty"}`,
          runtime: locked,
          ...card,
        });
        expect(created.statusCode, created.body).toBe(200);
        expect(await account(created.json().id)).toEqual({
          ...card,
          accountLock,
        });
      }

      // An agent that stores both, emptied one part at a time.
      const full = await create({
        name: `Codex ${accountLock} full`,
        runtime: locked,
        llmApiKeyId: own.key.id,
        modelId: own.model.id,
      });
      expect(full.statusCode, full.body).toBe(200);
      const id = full.json().id as string;
      const withoutModel = await update(id, { modelId: null });
      expect(withoutModel.statusCode, withoutModel.body).toBe(200);
      expect(await account(id)).toEqual({
        llmApiKeyId: own.key.id,
        modelId: null,
        accountLock,
      });
      const emptied = await editThroughMcp(id, {
        llmApiKeyId: null,
        modelId: null,
      });
      expect(emptied.isError, JSON.stringify(emptied.content)).toBe(false);
      expect(await account(id)).toEqual({
        llmApiKeyId: null,
        modelId: null,
        accountLock,
      });
      const connectionAlone = await editThroughMcp(id, {
        llmApiKeyId: other.key.id,
      });
      expect(
        connectionAlone.isError,
        JSON.stringify(connectionAlone.content),
      ).toBe(false);
      expect(await account(id)).toEqual({
        llmApiKeyId: other.key.id,
        modelId: null,
        accountLock,
      });

      // A model with no connection is still never stored, on either path.
      const loneModel = await update(id, {
        llmApiKeyId: null,
        modelId: own.model.id,
      });
      expect(loneModel.statusCode, loneModel.body).toBe(400);
      expect(loneModel.json().error.message).toBe(
        "An agent's model and API key must be set together",
      );
      const loneModelThroughMcp = await editThroughMcp(id, {
        llmApiKeyId: null,
        modelId: own.model.id,
      });
      expect(loneModelThroughMcp.isError).toBe(true);
      expect(await account(id)).toMatchObject({
        llmApiKeyId: other.key.id,
        modelId: null,
      });
    }

    // A connection without a model is the company API key: never someone's
    // own subscription.
    const personal = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4-own",
      userId: ctx.admin.id,
      apiKeyValue: "chatgpt-oauth:example-subscription",
    });
    const onSubscription = await create({
      name: "Codex on a subscription key",
      runtime: { ...codex, accountLock: null },
      llmApiKeyId: personal.key.id,
    });
    expect(onSubscription.statusCode, onSubscription.body).toBe(400);
    expect(onSubscription.json().error.message).toBe(
      "An API key set without a model must be a company API key, not a personal subscription. Choose its model too, or another API key.",
    );
  });

  test("applying runtime settings refuses locked agents whose lock they break", async () => {
    // A runtime on the Codex wrapper, whose agents can run on each person's
    // own subscription.
    const codex = makeTemplate({
      name: "Codex workspace",
      runtime: {
        ...makeTemplate().runtime,
        image: "registry.example.com/codex-workspace:v1",
        command: ["archestra-codex"],
        inferenceProtocol: "openai_chat",
      },
    });
    const save = async (runtime: Partial<(typeof codex)["runtime"]>) =>
      AgentRuntimeTemplateModel.saveSettings({
        organizationId: ctx.organizationId,
        settings: {
          revision: (
            await AgentRuntimeTemplateModel.getSettings(ctx.organizationId)
          ).revision,
          templates: [
            template,
            { ...codex, runtime: { ...codex.runtime, ...runtime } },
          ],
        },
        popularAgentOverrides: null,
      });
    await save({});
    ctx.caller = ctx.admin;
    const created = await create({
      runtime: { ...codex.runtime, accountLock: "subscription" },
      llmApiKeyId: own.key.id,
      modelId: own.model.id,
    });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().id as string;
    const apply = () =>
      ctx.app.inject({
        method: "POST",
        url: `/api/agent-runtime-templates/${codex.id}/apply-to-agents`,
      });

    // Settings that leave the account alone still apply to a locked agent.
    await save({ ttlHours: 6 });
    const unrelated = await apply();
    expect(unrelated.statusCode, unrelated.body).toBe(200);
    expect(await stored(id)).toMatchObject({
      ttlHours: 6,
      accountLock: "subscription",
    });

    // A command with no subscription of its own breaks a subscription lock.
    await save({ ttlHours: 6, command: ["archestra-opencode"] });
    const refused = await apply();
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toBe(
      "These settings don't work with the account lock of: Locked worker. Change or remove those agents' lock first.",
    );
    expect(await stored(id)).toMatchObject({
      command: ["archestra-codex"],
      accountLock: "subscription",
    });
  });

  test("a Claude account in a runtime's settings is not applied to its agents, so it breaks no lock", async () => {
    // A Claude Code runtime whose settings store company billing.
    const claude = makeTemplate({
      name: "Claude workspace",
      runtime: {
        ...makeTemplate().runtime,
        image: "registry.example.com/claude:v1",
        command: ["archestra-claude-code"],
        inferenceProtocol: "anthropic",
        claudeCode: { authentication: "provider" },
      },
    });
    const save = async (runtime: Partial<(typeof claude)["runtime"]>) =>
      AgentRuntimeTemplateModel.saveSettings({
        organizationId: ctx.organizationId,
        settings: {
          revision: (
            await AgentRuntimeTemplateModel.getSettings(ctx.organizationId)
          ).revision,
          templates: [
            template,
            { ...claude, runtime: { ...claude.runtime, ...runtime } },
          ],
        },
        popularAgentOverrides: null,
      });
    await save({});
    const anthropic = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
    ctx.caller = ctx.admin;
    const created = await create({
      runtime: { ...claude.runtime, accountLock: "key" },
      llmApiKeyId: anthropic.key.id,
      modelId: anthropic.model.id,
    });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().id as string;

    // The settings now store each person's subscription.
    await save({ ttlHours: 6, claudeCode: { authentication: "subscription" } });
    const applied = await ctx.app.inject({
      method: "POST",
      url: `/api/agent-runtime-templates/${claude.id}/apply-to-agents`,
    });

    expect(applied.statusCode, applied.body).toBe(200);
    expect(await stored(id)).toMatchObject({
      ttlHours: 6,
      claudeCode: { authentication: "provider" },
      accountLock: "key",
    });
  });

  test("re-sending a locked agent's model pool is not an account change", async () => {
    const id = await lockedAgent();
    const agent = await AgentModel.findById(id);
    assert(agent);
    const write = (modelPoolId: string | null) =>
      assertAccountLockWrite({
        organizationId: ctx.organizationId,
        // Someone the locked agent's account is not theirs to change.
        userId: editor.id,
        previous: {
          ...agent,
          modelPoolId: "00000000-0000-4000-8000-00000000a001",
        },
        runtime: undefined,
        account: {
          llmApiKeyId: agent.llmApiKeyId,
          modelId: agent.modelId,
          modelPoolId,
        },
      });

    await expect(
      write("00000000-0000-4000-8000-00000000a001"),
    ).resolves.toBeUndefined();
    await expect(
      write("00000000-0000-4000-8000-00000000a002"),
    ).rejects.toMatchObject({
      statusCode: 403,
      message:
        "This agent's account is locked. Only people who can configure the Engineering workspace runtime can change its account or runtime.",
    });
  });

  test("a copy of a locked agent starts unlocked and can run", async () => {
    const id = await lockedAgent();
    ctx.caller = ctx.member;
    const cloned = await ctx.app.inject({
      method: "POST",
      url: `/api/agents/${id}/clone`,
      payload: {},
    });
    expect(cloned.statusCode, cloned.body).toBe(200);
    const copyId = cloned.json().id as string;
    // As a new agent of theirs on this runtime would be stored: each person
    // chooses, whatever Claude account the runtime's settings store.
    expect(await stored(copyId)).toMatchObject({ accountLock: null });
    expect(await stored(id)).toMatchObject({ accountLock: "key" });

    // The copy has no key of its own; unlocked, its new owner's run resolves
    // one instead of being refused by a lock it cannot lift.
    const copy = await AgentModel.findById(copyId);
    assert(copy);
    expect(copy.llmApiKeyId).toBeNull();
    const copyRuntime = resolveAgentRuntime(copy);
    assert(copyRuntime);
    await expect(
      preflightAgentRuntimeModelReadiness({
        runtime: copyRuntime,
        agent: copy,
        actor: {
          kind: "user",
          id: ctx.member.id,
          organizationId: ctx.organizationId,
        },
      }),
    ).resolves.not.toThrow();
  });

  test("a copy of a Codex agent by someone who may only use the runtime lets them choose, as their own new agent would", async () => {
    await ctx.app.register(agentRuntimeRoutes);
    await grantRuntime({
      organizationId: ctx.organizationId,
      scope: agentRuntimePermissionScope({ kind: "built-in", id: "codex" }),
      userId: ctx.member.id,
      actions: ["read", "use"],
    });
    // The maintained Codex runtime, by its wrapper command.
    const codex = {
      ...template.runtime,
      image: "registry.example.com/archestra-codex:v1",
      command: ["archestra-codex"],
    };
    const account = { llmApiKeyId: own.key.id, modelId: own.model.id };
    ctx.caller = ctx.admin;
    const source = await create({ runtime: codex, ...account });
    expect(source.statusCode, source.body).toBe(200);

    ctx.caller = ctx.member;
    const fresh = await create({ runtime: codex, ...account });
    expect(fresh.statusCode, fresh.body).toBe(200);
    const copy = await ctx.app.inject({
      method: "POST",
      url: `/api/agents/${source.json().id}/clone`,
      payload: {},
    });
    expect(copy.statusCode, copy.body).toBe(200);
    const copyId = copy.json().id as string;

    expect(await stored(fresh.json().id)).toMatchObject({ accountLock: null });
    expect(await stored(copyId)).toMatchObject({ accountLock: null });
    const chosen = await ctx.app.inject({
      method: "PUT",
      url: `/api/agents/${copyId}/runtime/account`,
      payload: { authentication: "subscription" },
    });
    expect(chosen.statusCode, chosen.body).toBe(200);
    expect(chosen.json()).toMatchObject({
      lock: null,
      choice: { authentication: "subscription" },
    });
  });

  describe("on a runtime that stores a Claude account and no rule, for someone who may only use it", () => {
    // Company billing is what this runtime's new agents start on.
    const claude = makeTemplate({
      name: "Claude workspace",
      position: 2,
      runtime: {
        ...makeTemplate().runtime,
        image: "example.com/claude-workspace:latest",
        command: ["claude-workspace"],
        inferenceProtocol: "anthropic",
        claudeCode: { authentication: "provider" },
      },
    });
    // A runtime that stores no Claude account.
    const open = makeTemplate({
      name: "Open workspace",
      position: 3,
      runtime: {
        ...makeTemplate().runtime,
        image: "example.com/open-workspace:latest",
        inferenceProtocol: "anthropic",
      },
    });
    let anthropic: Awaited<ReturnType<typeof makeKeyWithModel>>;

    beforeEach(async () => {
      await ctx.app.register(agentRuntimeRoutes);
      const current = await AgentRuntimeTemplateModel.getSettings(
        ctx.organizationId,
      );
      await AgentRuntimeTemplateModel.saveSettings({
        organizationId: ctx.organizationId,
        settings: { ...current, templates: [template, claude, open] },
        popularAgentOverrides: null,
      });
      for (const scope of [claude.id, open.id]) {
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
    /** The member asks to run the agent on their own Claude subscription. */
    const chooseSubscription = (id: string) =>
      ctx.app.inject({
        method: "PUT",
        url: `/api/agents/${id}/runtime/account`,
        payload: { authentication: "subscription" },
      });
    /**
     * The agent lets each person choose, as on a runtime that stores no
     * Claude account: the member takes their own subscription for it.
     */
    const expectEachPersonChooses = async (id: string) => {
      expect(await stored(id)).toMatchObject({
        claudeCode: { authentication: "provider" },
        accountLock: null,
      });
      ctx.caller = ctx.member;
      const chosen = await chooseSubscription(id);
      expect(chosen.statusCode, chosen.body).toBe(200);
      expect(chosen.json()).toMatchObject({
        lock: null,
        choice: { authentication: "subscription" },
      });
      expect(
        await AgentRuntimeUserAccountModel.find({
          agentId: id,
          userId: ctx.member.id,
        }),
      ).toMatchObject({ authentication: "subscription" });
    };

    test("their copy of an agent lets each person choose, as their own new agent does", async () => {
      ctx.caller = ctx.admin;
      const source = await create({
        runtime: { ...claude.runtime, accountLock: "key" },
        ...account(),
      });
      expect(source.statusCode, source.body).toBe(200);

      ctx.caller = ctx.member;
      const fresh = await create({ runtime: claude.runtime, ...account() });
      expect(fresh.statusCode, fresh.body).toBe(200);
      const copy = await ctx.app.inject({
        method: "POST",
        url: `/api/agents/${source.json().id}/clone`,
        payload: {},
      });
      expect(copy.statusCode, copy.body).toBe(200);

      await expectEachPersonChooses(fresh.json().id);
      await expectEachPersonChooses(copy.json().id);
    });

    test("an agent they move here keeps the account they name for it", async () => {
      const elsewhere = async () => {
        ctx.caller = ctx.member;
        const created = await create({ runtime: open.runtime, ...account() });
        expect(created.statusCode, created.body).toBe(200);
        expect(await stored(created.json().id)).toMatchObject({
          accountLock: null,
        });
        return created.json().id as string;
      };
      // Each person's choice carries over, named on the move or not.
      for (const moved of [
        claude.runtime,
        { ...claude.runtime, accountLock: null },
      ]) {
        const id = await elsewhere();

        const response = await update(id, { runtime: moved });

        expect(response.statusCode, response.body).toBe(200);
        await expectEachPersonChooses(id);
      }

      // A lock and the other Claude account they name are stored as sent.
      for (const named of [
        { accountLock: "key" },
        {
          claudeCode: { authentication: "subscription" },
          accountLock: "subscription",
        },
      ] as const) {
        const id = await elsewhere();

        const response = await update(id, {
          runtime: { ...claude.runtime, ...named },
        });

        expect(response.statusCode, response.body).toBe(200);
        expect(await stored(id)).toMatchObject({
          image: claude.runtime.image,
          claudeCode: { authentication: "provider" },
          ...named,
        });
      }
    });

    test("removing the runtime and adding it back keeps each person's choice", async () => {
      ctx.caller = ctx.member;
      const created = await create({ runtime: claude.runtime, ...account() });
      expect(created.statusCode, created.body).toBe(200);
      const id = created.json().id as string;

      expect((await update(id, { runtime: null })).statusCode).toBe(200);
      const added = await update(id, { runtime: claude.runtime });
      expect(added.statusCode, added.body).toBe(200);

      await expectEachPersonChooses(id);
    });

    test("a configurer who moves an agent here keeps each person's choice", async () => {
      ctx.caller = ctx.admin;
      const elsewhere = await create({ runtime: runtime(), ...account() });
      const id = elsewhere.json().id as string;

      const moved = await update(id, { runtime: claude.runtime });

      expect(moved.statusCode, moved.body).toBe(200);
      expect(await stored(id)).toMatchObject({ accountLock: null });
    });

    test("a lock is checked again when the agent's Claude account changes", async () => {
      ctx.caller = ctx.admin;
      const locked = await create({
        runtime: { ...claude.runtime, accountLock: "key" },
        ...account(),
      });
      expect(locked.statusCode, locked.body).toBe(200);
      const id = locked.json().id as string;

      const refused = await update(id, {
        runtime: {
          ...claude.runtime,
          claudeCode: { authentication: "subscription" },
          accountLock: "key",
        },
      });

      expect(refused.statusCode, refused.body).toBe(400);
      expect(refused.json().error.message).toBe(
        "To lock this agent to a company API key, its own account must be a company API key.",
      );
      expect(await stored(id)).toMatchObject({
        claudeCode: { authentication: "provider" },
        accountLock: "key",
      });
    });
  });

  test("restoring a version obeys the lock", async () => {
    ctx.caller = ctx.admin;
    const created = await create({
      runtime: runtime(),
      llmApiKeyId: other.key.id,
      modelId: other.model.id,
    });
    const id = created.json().id as string;
    await AgentVersionModel.forkIfChanged(id);
    const latest = async () =>
      (
        await AgentVersionModel.listForAgent({
          agentId: id,
          organizationId: ctx.organizationId,
          pagination: { limit: 1, offset: 0 },
        })
      ).data[0]?.version;
    const before = await latest();
    expect(
      (
        await update(id, {
          runtime: runtime("key"),
          llmApiKeyId: own.key.id,
          modelId: own.model.id,
        })
      ).statusCode,
    ).toBe(200);

    // Someone the locked agent's account is not theirs to change.
    ctx.caller = editor;
    const restore = await ctx.app.inject({
      method: "POST",
      url: `/api/agents/${id}/versions/${before}/restore`,
      payload: {},
    });
    expect(restore.statusCode).toBe(403);
    expect(restore.json().error.message).toBe(
      "This agent's account is locked. Only people who can configure the Engineering workspace runtime can change its account or runtime.",
    );
    expect(await AgentModel.findById(id)).toMatchObject({
      llmApiKeyId: own.key.id,
    });
  });

  test("the agent update audit records the lock change", async () => {
    const id = await lockedAgent();
    expect((await update(id, { runtime: runtime(null) })).statusCode).toBe(200);
    await drainBackgroundWork();
    const audits = await db
      .select()
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.organizationId, ctx.organizationId),
          eq(schema.auditLogsTable.httpRoute, "/api/agents/:id"),
          eq(schema.auditLogsTable.httpMethod, "PUT"),
          eq(schema.auditLogsTable.outcome, "success"),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0].before)).toContain('"accountLock":"key"');
    expect(JSON.stringify(audits[0].after)).toContain('"accountLock":null');
  });

  test("a lock saved through the update route reaches the run's launch spec", async () => {
    const id = await lockedAgent();
    // Save the lock away from the key: the run must refuse, not fall back.
    ctx.caller = ctx.admin;
    const unlocked = await update(id, { runtime: runtime(null) });
    expect(unlocked.statusCode, unlocked.body).toBe(200);
    const relocked = await update(id, { runtime: runtime("key") });
    expect(relocked.statusCode, relocked.body).toBe(200);

    const agent = await AgentModel.findById(id);
    assert(agent);
    expect(resolveAgentRuntime(agent)?.accountLock).toBe("key");

    const run = await launchAs(id, ctx.member.id);
    expect(await boundKeyIds(run)).toEqual([own.key.id]);

    // A choice of their subscription stored earlier is set aside by the lock.
    await AgentRuntimeUserAccountModel.upsert({
      agentId: id,
      userId: ctx.member.id,
      authentication: "subscription",
      modelId: null,
    });
    const again = await launchAs(id, ctx.member.id);
    expect(await boundKeyIds(again)).toEqual([own.key.id]);
  });

  test("a subscription lock fits a company-key agent only on a runtime with a subscription of its own", async () => {
    ctx.caller = ctx.admin;
    const xai = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "xai",
      modelId: "grok-4.3",
    });
    // A maintained runtime by its wrapper command, on an image of its own.
    const maintained = (
      command: string,
      accountLock?: AgentRuntime["accountLock"],
    ) => ({
      ...template.runtime,
      image: `registry.example.com/${command}:v1`,
      command: [command],
      ...(accountLock !== undefined && { accountLock }),
    });

    // Grok Build runs on SuperGrok: the lock is accepted although the agent
    // stores a company xAI key, which stays stored.
    const created = await create({
      name: "Grok worker",
      runtime: maintained("archestra-grok"),
      llmApiKeyId: xai.key.id,
      modelId: xai.model.id,
    });
    expect(created.statusCode, created.body).toBe(200);
    const grokId = created.json().id as string;
    const locked = await update(grokId, {
      runtime: maintained("archestra-grok", "subscription"),
    });
    expect(locked.statusCode, locked.body).toBe(200);
    expect(await AgentModel.findById(grokId)).toMatchObject({
      llmApiKeyId: xai.key.id,
      modelId: xai.model.id,
      runtime: { accountLock: "subscription" },
    });

    // Its runs never fall back to the company key: each person's own
    // SuperGrok is needed, then bound.
    await expect(launchAs(grokId, ctx.member.id)).rejects.toMatchObject({
      statusCode: 409,
      message:
        "Connect your own SuperGrok before starting this Agent. It is locked to each person's own subscription.",
    });
    const superGrok = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "xai",
      modelId: "grok-4.3",
      userId: ctx.member.id,
      apiKeyValue: "xai-subscription:example-subscription",
    });
    expect(await boundKeyIds(await launchAs(grokId, ctx.member.id))).toEqual([
      superGrok.key.id,
    ]);

    // OpenCode has no subscription of its own, whatever its model's provider:
    // with a company key the same lock is refused, on update and on create.
    const refusal =
      "To lock this agent to each person's own subscription, its own account must be a personal subscription.";
    for (const account of [own, xai]) {
      const openCode = await create({
        name: `OpenCode worker ${account.model.modelId}`,
        runtime: maintained("archestra-opencode"),
        llmApiKeyId: account.key.id,
        modelId: account.model.id,
      });
      expect(openCode.statusCode, openCode.body).toBe(200);
      const openCodeId = openCode.json().id as string;
      const refused = await update(openCodeId, {
        runtime: maintained("archestra-opencode", "subscription"),
      });
      expect(refused.statusCode, refused.body).toBe(400);
      expect(refused.json().error.message).toBe(refusal);
      expect(await stored(openCodeId)).toMatchObject({ accountLock: null });

      const refusedCreate = await create({
        name: `Locked OpenCode worker ${account.model.modelId}`,
        runtime: maintained("archestra-opencode", "subscription"),
        llmApiKeyId: account.key.id,
        modelId: account.model.id,
      });
      expect(refusedCreate.statusCode, refusedCreate.body).toBe(400);
      expect(refusedCreate.json().error.message).toBe(refusal);
    }
  });

  test("the MCP edit tool keeps the lock and obeys it", async () => {
    const id = await lockedAgent();
    const editAs = (user: User, args: object) =>
      executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}edit_agent`,
        { id, ...args },
        {
          agent: { id, name: "Locked worker" },
          userId: user.id,
          organizationId: ctx.organizationId,
        },
      );

    // Someone who may not use the agent's runtime does not choose its
    // account, nor take its runtime away.
    const refused = await editAs(editor, {
      llmApiKeyId: other.key.id,
      modelId: other.model.id,
    });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain(
      "can change its account or runtime",
    );
    const removed = await editAs(editor, { runtime: null });
    expect(removed.isError).toBe(true);
    expect(JSON.stringify(removed.content)).toContain(NO_USE);
    expect(await AgentModel.findById(id)).toMatchObject({
      llmApiKeyId: own.key.id,
      runtime: { accountLock: "key" },
    });

    // A runtime sent without a lock keeps the stored one.
    const resaved = await editAs(ctx.member, {
      runtime: { image: template.runtime.image },
    });
    expect(resaved.isError, JSON.stringify(resaved.content)).toBe(false);
    expect(await stored(id)).toMatchObject({ accountLock: "key" });
  });
});
