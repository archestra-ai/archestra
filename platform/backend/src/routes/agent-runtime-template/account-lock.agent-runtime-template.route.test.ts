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
import type { AgentRuntime, User } from "@/types";
import type { RuntimeTemplateSettingsInput } from "@/types/agent-runtime-template";
import agentRoutes from "../agent";
import {
  makeTemplate,
  useTemplateRouteTestApp,
} from "./runtime-template.test-data";

vi.mock("@/observability");

const NO_RUNTIME =
  "Configure runtime permission is required to change an agent runtime";
const NOT_THEIRS_TO_LOCK =
  "Only an administrator can lock the account of this agent.";
const NOT_THEIRS_TO_UNLOCK =
  "This agent's account is locked. Only an administrator can change or remove the lock.";

// Changing an agent's account lock changes its runtime, so it needs
// permission to configure an agent's runtime. Where the runtime leaves the
// account kind to each agent and is not locked, that permission is enough;
// on a runtime whose account rule names a kind, or a locked one, only an
// administrator, who may change the organization's settings, chooses it.
describe("an agent's account lock", () => {
  const ctx = useTemplateRouteTestApp();
  // A custom runtime that runs Claude Code and names no account kind.
  const template = makeTemplate({
    runtime: {
      ...makeTemplate().runtime,
      command: ["archestra-claude-code"],
      inferenceProtocol: "anthropic",
      claudeCode: { authentication: "provider" },
    },
  });
  const claudeCode = (): AgentRuntime =>
    buildAgentCatalogRuntime({
      id: "claude-code",
      image: config.agentRuntime.catalogImages["claude-code"],
    });
  let anthropic: Awaited<ReturnType<typeof makeKeyWithModel>>;
  /** May configure an agent's runtime, not the organization's settings. */
  let builder: User;
  /** May edit every agent, not configure its runtime. */
  let editor: User;

  beforeEach(async ({ makeUser, makeCustomRole, makeMember }) => {
    await ctx.app.register(agentRoutes);
    vi.spyOn(agentSandboxApi, "isInstalled", "get").mockReturnValue(true);
    await AgentRuntimeTemplateModel.saveSettings({
      organizationId: ctx.organizationId,
      settings: { revision: 0, templates: [template] },
      popularAgentOverrides: null,
    });
    const memberWith = async (agent: string[]) => {
      const user = await makeUser();
      const role = await makeCustomRole(ctx.organizationId, {
        permission: { agent, llmProviderApiKey: ["read"] },
      });
      await makeMember(user.id, ctx.organizationId, { role: role.role });
      // Every agent and key of the organization is theirs to edit and use.
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
      return user;
    };
    builder = await memberWith([
      "read",
      "create",
      "update",
      "configure-runtime",
    ]);
    editor = await memberWith(["read", "create", "update"]);
    anthropic = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
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
      payload: {
        agentType: "agent",
        name: "Locked worker",
        llmApiKeyId: anthropic.key.id,
        modelId: anthropic.model.id,
        ...body,
      },
    });
  const update = (id: string, body: object) =>
    ctx.app.inject({ method: "PUT", url: `/api/agents/${id}`, payload: body });
  const stored = async (id: string) => (await AgentModel.findById(id))?.runtime;
  /** Save the runtime settings as the caller, over the stored ones. */
  const saveSettings = async (
    settings: Partial<
      Pick<RuntimeTemplateSettingsInput, "templates" | "builtIns">
    >,
  ) =>
    ctx.app.inject({
      method: "PUT",
      url: "/api/agent-runtime-templates/settings",
      payload: {
        ...(await AgentRuntimeTemplateModel.getSettings(ctx.organizationId)),
        ...settings,
      },
    });

  test("where the runtime leaves the account kind to each agent, a builder sets, changes and removes the lock", async () => {
    ctx.caller = builder;
    const created = await create({ runtime: runtime("key") });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().id as string;
    expect(await stored(id)).toMatchObject({ accountLock: "key" });

    // One an administrator set is theirs to change too.
    ctx.caller = ctx.admin;
    const byAdministrator = await create({ runtime: runtime("key") });
    expect(byAdministrator.statusCode, byAdministrator.body).toBe(200);

    ctx.caller = builder;
    for (const agentId of [id, byAdministrator.json().id as string]) {
      const unlocked = await update(agentId, { runtime: runtime(null) });
      expect(unlocked.statusCode, unlocked.body).toBe(200);
      expect(await stored(agentId)).toMatchObject({ accountLock: null });
      const relocked = await update(agentId, { runtime: runtime("key") });
      expect(relocked.statusCode, relocked.body).toBe(200);
      expect(await stored(agentId)).toMatchObject({ accountLock: "key" });
    }
  });

  test("someone who may edit an agent but not configure its runtime cannot change its lock", async () => {
    ctx.caller = builder;
    const created = await create({ runtime: runtime("key") });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().id as string;

    ctx.caller = editor;
    const refused = await update(id, { runtime: runtime(null) });

    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().error.message).toBe(NO_RUNTIME);
    expect(await stored(id)).toMatchObject({ accountLock: "key" });
  });

  test("where the runtime's account rule names a kind, only an administrator saves the rule and chooses an agent's lock", async () => {
    // The rule is part of the runtime settings, which a builder cannot save.
    const ruled = { ...template, accounts: { kind: "key" as const } };
    ctx.caller = builder;
    expect((await saveSettings({ templates: [ruled] })).statusCode).toBe(403);
    ctx.caller = ctx.admin;
    const saved = await saveSettings({ templates: [ruled] });
    expect(saved.statusCode, saved.body).toBe(200);

    // A builder still builds agents there, without a lock of their own.
    ctx.caller = builder;
    const open = await create({ runtime: runtime(null) });
    expect(open.statusCode, open.body).toBe(200);
    for (const refused of [
      await create({ runtime: runtime("key") }),
      await update(open.json().id, { runtime: runtime("key") }),
    ]) {
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().error.message).toBe(NOT_THEIRS_TO_LOCK);
    }
    expect(await stored(open.json().id)).toMatchObject({ accountLock: null });

    // The lock an administrator sets there is not theirs to remove.
    ctx.caller = ctx.admin;
    const locked = await create({ runtime: runtime("key") });
    expect(locked.statusCode, locked.body).toBe(200);
    ctx.caller = builder;
    const removed = await update(locked.json().id, { runtime: runtime(null) });
    expect(removed.statusCode, removed.body).toBe(403);
    expect(removed.json().error.message).toBe(NOT_THEIRS_TO_UNLOCK);
    expect(await stored(locked.json().id)).toMatchObject({
      accountLock: "key",
    });
  });

  test("a builder's agent on a locked Claude Code runtime is locked to the kind of the runtime's Claude account", async () => {
    for (const [authentication, accountLock] of [
      ["subscription", "subscription"],
      ["provider", "key"],
    ] as const) {
      ctx.caller = ctx.admin;
      const locked = await saveSettings({
        builtIns: {
          "claude-code": {
            locked: true,
            settings: { claudeCode: { authentication } },
          },
        },
      });
      expect(locked.statusCode, locked.body).toBe(200);

      ctx.caller = builder;
      const created = await create({ runtime: claudeCode() });

      expect(created.statusCode, created.body).toBe(200);
      expect(await stored(created.json().id)).toMatchObject({
        claudeCode: { authentication },
        accountLock,
      });
    }
  });

  test("saving a locked Claude Code runtime locks the agents saved since people could choose, and leaves the ones saved before without a lock", async ({
    makeAgent,
  }) => {
    const onProvider = {
      ...claudeCode(),
      claudeCode: { authentication: "provider" as const },
    };
    const [savedSince, savedBefore] = await Promise.all(
      [{ ...onProvider, accountLock: null }, onProvider].map(
        (agentRuntime, index) =>
          makeAgent({
            organizationId: ctx.organizationId,
            agentType: "agent",
            name: `Claude worker ${index}`,
            llmApiKeyId: anthropic.key.id,
            modelId: anthropic.model.id,
            runtime: agentRuntime,
          }),
      ),
    );

    const saved = await saveSettings({
      builtIns: {
        "claude-code": {
          locked: true,
          settings: { claudeCode: { authentication: "subscription" } },
        },
      },
    });

    expect(saved.statusCode, saved.body).toBe(200);
    expect(await stored(savedSince.id)).toMatchObject({
      claudeCode: { authentication: "subscription" },
      accountLock: "subscription",
    });
    // It runs on the Claude account written on it, and names no lock.
    const before = await stored(savedBefore.id);
    expect(before).toMatchObject({
      claudeCode: { authentication: "subscription" },
    });
    expect(before).not.toHaveProperty("accountLock");
  });
});
