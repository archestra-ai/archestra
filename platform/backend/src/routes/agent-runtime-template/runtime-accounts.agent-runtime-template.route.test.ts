// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  ARCHESTRA_MCP_SERVER_NAME,
  buildAgentCatalogRuntime,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  runtimeSupportsClaudeSubscription,
  type SupportedProvider,
} from "@archestra/shared";
import { assert, vi } from "vitest";
import { executeArchestraTool } from "@/archestra-mcp-server";
import config from "@/config";
import { agentSandboxApi } from "@/k8s/agent-runtime/sandbox-api";
import {
  AgentRuntimeUserAccountModel,
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  VirtualApiKeyModel,
} from "@/models";
import AgentModel from "@/models/agent";
import AgentRuntimeTemplateModel from "@/models/agent-runtime-template";
import AgentVersionModel from "@/models/agent-version";
import AuditLogModel from "@/models/audit-log";
import {
  companyAccountSetBy,
  makeKeyWithModel,
} from "@/routes/agent-runtime/agent-runtime-account.test-helpers";
import { claudeCodeAccountManager } from "@/services/agent-runtime/claude-code-account";
import { buildAgentRunLaunchSpec } from "@/services/agent-runtime/launch-spec";
import { resolveAgentRuntime } from "@/services/agent-runtime/pod-run";
import { beforeEach, describe, expect, test } from "@/test";
import { grantRoleEverywhere } from "@/test/wildcard-grants";
import { type AgentRuntime, ApiError, type User } from "@/types";
import { drainBackgroundWork } from "@/utils/background-work";
import agentRoutes from "../agent";
import agentRuntimeRoutes from "../agent-runtime/agent-runtime.routes";
import {
  makeTemplate,
  useTemplateRouteTestApp,
} from "./runtime-template.test-data";

vi.mock("@/observability");

type Connection = Awaited<ReturnType<typeof makeKeyWithModel>>;
type MaintainedId = "claude-code" | "codex" | "opencode";
type Rule = {
  kind?: string;
  llmApiKeyId?: string;
  modelId?: string;
};

describe("a runtime's account rule", () => {
  const ctx = useTemplateRouteTestApp();
  // A custom runtime on an OpenAI protocol that sets no Claude account.
  const custom = makeTemplate({
    runtime: { ...makeTemplate().runtime, inferenceProtocol: "openai_chat" },
  });
  const maintained = (id: MaintainedId): AgentRuntime =>
    buildAgentCatalogRuntime({
      id,
      image: config.agentRuntime.catalogImages[id],
    });
  const customRuntime = (): AgentRuntime => custom.runtime;

  beforeEach(async ({ makeUser, makeCustomRole, makeMember }) => {
    await ctx.app.register(agentRoutes);
    await ctx.app.register(agentRuntimeRoutes);
    vi.spyOn(agentSandboxApi, "isInstalled", "get").mockReturnValue(true);
    vi.spyOn(config.agentRuntime, "platformBaseUrl", "get").mockReturnValue(
      "https://platform.example.test",
    );
    // Everyone's own Claude sign-in is connected; the account adapter is the
    // external storage boundary.
    vi.spyOn(claudeCodeAccountManager, "requireConnection").mockResolvedValue(
      undefined as never,
    );
    vi.spyOn(claudeCodeAccountManager, "status").mockResolvedValue({
      state: "connected",
    } as never);
    await AgentRuntimeTemplateModel.saveSettings({
      organizationId: ctx.organizationId,
      settings: { revision: 0, templates: [custom] },
      popularAgentOverrides: null,
    });
    // An agent builder who may configure an agent's runtime but not the
    // organization's settings, and who reaches only the connections shared
    // with everyone.
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
  });

  const create = (body: object) =>
    ctx.app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { agentType: "agent", name: "Worker", ...body },
    });
  const update = (id: string, body: object) =>
    ctx.app.inject({ method: "PUT", url: `/api/agents/${id}`, payload: body });
  const copy = (id: string) =>
    ctx.app.inject({
      method: "POST",
      url: `/api/agents/${id}/clone`,
      payload: {},
    });
  /** Everything of an agent a runtime's rule could have been written to. */
  const stored = async (id: string) => {
    const agent = await AgentModel.findById(id);
    assert(agent);
    return {
      llmApiKeyId: agent.llmApiKeyId,
      modelId: agent.modelId,
      runtime: agent.runtime,
      updatedAt: agent.updatedAt,
    };
  };
  const pair = (connection: Connection) => ({
    llmApiKeyId: connection.key.id,
    modelId: connection.model.id,
  });

  /** An administrator saves runtime settings over the current ones. */
  const save = async (patch: { templates?: object[]; builtIns?: object }) => {
    ctx.caller = ctx.admin;
    const current = await AgentRuntimeTemplateModel.getSettings(
      ctx.organizationId,
    );
    return ctx.app.inject({
      method: "PUT",
      url: "/api/agent-runtime-templates/settings",
      payload: { ...current, ...patch },
    });
  };
  const saved = async (patch: Parameters<typeof save>[0]) => {
    const response = await save(patch);
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  };
  const refusal = async (patch: Parameters<typeof save>[0], status = 400) => {
    const response = await save(patch);
    expect(response.statusCode, response.body).toBe(status);
    return response.json().error.message as string;
  };
  const customWith = (accounts?: Rule) => ({
    templates: [{ ...custom, ...(accounts && { accounts }) }],
  });
  const builtInWith = (id: MaintainedId, settings: object) => ({
    builtIns: { [id]: { locked: false, settings } },
  });

  /**
   * A company connection only administrators were given, with two models,
   * and one shared with everyone, of the same provider.
   */
  const connections = async (
    provider: SupportedProvider,
    models: [string, string, string],
  ) => {
    const company = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider,
      modelId: models[0],
      adminsOnly: true,
    });
    const shared = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider,
      modelId: models[2],
    });
    const other = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider,
      modelId: models[1],
      adminsOnly: true,
    });
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(company.key.id, [
      other.model.id,
    ]);
    return { company, secondModelId: other.model.id, shared };
  };
  const openai = () =>
    connections("openai", ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"]);

  // What a person's run of an agent resolves to, on the three paths that
  // must agree: the account route, the preflight and the launch.
  const as = <T>(user: User, request: () => Promise<T>) => {
    ctx.caller = user;
    return request();
  };
  const accountOf = (id: string, user: User) =>
    as(user, async () =>
      (
        await ctx.app.inject({
          method: "GET",
          url: `/api/agents/${id}/runtime/account`,
        })
      ).json(),
    );
  const preflightOf = (id: string, user: User) =>
    as(user, async () =>
      (
        await ctx.app.inject({
          method: "GET",
          url: `/api/agents/${id}/runtime/preflight`,
        })
      ).json(),
    );
  const launchOf = async (id: string, user: User) => {
    const agent = await AgentModel.findById(id);
    assert(agent);
    const runtime = resolveAgentRuntime(agent);
    assert(runtime);
    const run = await buildAgentRunLaunchSpec({
      runtime,
      taskId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      agentId: id,
      actor: { kind: "user", id: user.id, organizationId: ctx.organizationId },
      organizationId: ctx.organizationId,
      runtimeScope: "agent-tests",
      effectiveNetworkPolicy: { source: "built_in", policy: null },
      appName: "Archestra",
      runMode: "one_shot",
    });
    assert(run.virtualApiKeyId);
    const key = await VirtualApiKeyModel.findById(run.virtualApiKeyId);
    return {
      // A passthrough key carries the person's own Claude subscription.
      subscription: key?.keyType === "passthrough",
      boundKeyIds: (
        await VirtualApiKeyModel.getProviderApiKeys(run.virtualApiKeyId)
      ).map((entry) => entry.providerApiKeyId),
      model: run.spec.env.ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL,
    };
  };
  const choose = (
    agentId: string,
    user: User,
    authentication: "subscription" | "provider",
  ) =>
    AgentRuntimeUserAccountModel.upsert({
      agentId,
      userId: user.id,
      authentication,
      modelId: null,
    });

  describe("holds for every agent on the runtime at once, and is written on none", () => {
    test("Claude Code named to a company key on one connection and model: an existing agent on each person's choice runs on them, until the rule is cleared", async ({
      makeAgent,
    }) => {
      const { company, shared } = await connections("anthropic", [
        "claude-sonnet-4-5",
        "claude-opus-4-5",
        "claude-haiku-4-5",
      ]);
      // An agent as it was: each person chooses, on another connection, and
      // one person chose their own Claude subscription.
      const agent = await makeAgent({
        organizationId: ctx.organizationId,
        authorId: ctx.admin.id,
        agentType: "agent",
        name: "Existing worker",
        ...pair(shared),
        runtime: { ...maintained("claude-code"), accountLock: null },
      });
      await choose(agent.id, ctx.member, "subscription");
      const before = await stored(agent.id);
      const earlier = {
        account: {
          lock: null,
          agentAccount: { authentication: "subscription", ...pair(shared) },
          choice: { authentication: "subscription" },
          choiceError: null,
        },
        preflight: { ready: true, accountError: null },
        launch: { subscription: true, boundKeyIds: [] },
      };
      const expectEarlierState = async () => {
        expect(await accountOf(agent.id, ctx.member)).toMatchObject(
          earlier.account,
        );
        expect(await preflightOf(agent.id, ctx.member)).toMatchObject(
          earlier.preflight,
        );
        expect(await launchOf(agent.id, ctx.member)).toMatchObject(
          earlier.launch,
        );
      };
      await expectEarlierState();

      await saved(
        builtInWith("claude-code", {
          accounts: { kind: "key", ...pair(company) },
        }),
      );

      // For the person who chose a subscription, and for an administrator
      // alike.
      for (const person of [ctx.member, ctx.admin]) {
        expect(await accountOf(agent.id, person)).toMatchObject({
          lock: "key",
          agentAccount: { authentication: "provider", ...pair(company) },
          companyKey: true,
          // Named to the person who may not read the connection too.
          companyAccount: {
            connection: {
              id: company.key.id,
              name: company.key.name,
              provider: "anthropic",
              fixedBy: "runtime",
            },
            model: {
              id: company.model.id,
              name: "claude-sonnet-4-5",
              fixedBy: "runtime",
            },
            usesOrganizationDefault: false,
          },
        });
        expect(await preflightOf(agent.id, person)).toMatchObject({
          ready: true,
          accountError: null,
        });
        expect(await launchOf(agent.id, person)).toEqual({
          subscription: false,
          boundKeyIds: [company.key.id],
          model: "claude-sonnet-4-5",
        });
      }
      // Their choice of the other kind is set aside, as under a lock.
      expect(await accountOf(agent.id, ctx.member)).toMatchObject({
        choice: { authentication: "subscription" },
        choiceError:
          "This agent is locked to a company API key, so your own choice is not used.",
      });
      expect(await stored(agent.id)).toEqual(before);

      await saved(builtInWith("claude-code", {}));

      await expectEarlierState();
      expect(await stored(agent.id)).toEqual(before);
    });

    test("Codex named to each person's subscription: an existing agent on its company key runs on subscriptions, until the rule is cleared", async ({
      makeAgent,
    }) => {
      const { shared } = await openai();
      const chatgpt = await makeKeyWithModel({
        organizationId: ctx.organizationId,
        provider: "openai",
        modelId: "gpt-5.4-nano",
        userId: ctx.member.id,
        apiKeyValue: "chatgpt-oauth:example-subscription",
      });
      // Locked to its own key by hand, as an administrator could.
      const agent = await makeAgent({
        organizationId: ctx.organizationId,
        authorId: ctx.admin.id,
        agentType: "agent",
        name: "Existing worker",
        ...pair(shared),
        runtime: { ...maintained("codex"), accountLock: "key" },
      });
      const before = await stored(agent.id);
      const expectEarlierState = async () => {
        expect(await accountOf(agent.id, ctx.member)).toMatchObject({
          lock: "key",
          agentAccount: { authentication: "provider" },
        });
        expect(await preflightOf(agent.id, ctx.member)).toMatchObject({
          ready: true,
        });
        expect(await launchOf(agent.id, ctx.member)).toMatchObject({
          boundKeyIds: [shared.key.id],
        });
      };
      await expectEarlierState();

      await saved(builtInWith("codex", { accounts: { kind: "subscription" } }));

      expect(await accountOf(agent.id, ctx.member)).toMatchObject({
        lock: "subscription",
        agentAccount: { authentication: "subscription" },
      });
      expect(await preflightOf(agent.id, ctx.member)).toMatchObject({
        ready: true,
        accountError: null,
      });
      expect(await launchOf(agent.id, ctx.member)).toMatchObject({
        boundKeyIds: [chatgpt.key.id],
      });
      // Someone who has not connected theirs is asked to, also an
      // administrator.
      expect(await preflightOf(agent.id, ctx.admin)).toMatchObject({
        ready: false,
        missingSubscription: "chatgpt",
      });
      expect(await stored(agent.id)).toEqual(before);

      await saved(builtInWith("codex", {}));

      await expectEarlierState();
    });

    test("a custom image that runs Claude Code and names subscriptions: an agent that stores no Claude account of its own runs on each person's, and they can sign in for it", async ({
      makeAgent,
    }) => {
      // The Claude sign-in is for a runtime that runs Claude Code, and
      // refuses any other: here it refuses as the real one does.
      const forClaudeRuntimesOnly = <T>(answer: T) =>
        (async (owner: {
          runtime: Parameters<typeof runtimeSupportsClaudeSubscription>[0];
        }) => {
          if (!runtimeSupportsClaudeSubscription(owner.runtime)) {
            throw new ApiError(
              400,
              "Claude subscriptions are only available in the Claude Code runtime.",
            );
          }
          return answer;
        }) as never;
      vi.spyOn(claudeCodeAccountManager, "status").mockImplementation(
        forClaudeRuntimesOnly({ state: "connected" }),
      );
      vi.spyOn(
        claudeCodeAccountManager,
        "requireConnection",
      ).mockImplementation(forClaudeRuntimesOnly(undefined));
      // Its command is the maintained Claude Code one. The agent was made
      // while the runtime set no Claude account.
      const anthropicCustom = {
        ...custom,
        runtime: {
          ...custom.runtime,
          command: ["archestra-claude-code"],
          inferenceProtocol: "anthropic" as const,
        },
      };
      await saved({ templates: [anthropicCustom] });
      const agent = await makeAgent({
        organizationId: ctx.organizationId,
        authorId: ctx.admin.id,
        agentType: "agent",
        name: "Existing worker",
        runtime: anthropicCustom.runtime,
      });
      expect((await stored(agent.id)).runtime).not.toHaveProperty("claudeCode");

      await saved({
        templates: [
          {
            ...anthropicCustom,
            runtime: {
              ...anthropicCustom.runtime,
              claudeCode: { authentication: "subscription" },
            },
            accounts: { kind: "subscription" },
          },
        ],
      });

      // The account route, the preflight and the launch agree.
      expect(await accountOf(agent.id, ctx.member)).toMatchObject({
        lock: "subscription",
        subscription: { kind: "claude", connected: true },
      });
      const preflight = await as(ctx.member, () =>
        ctx.app.inject({
          method: "GET",
          url: `/api/agents/${agent.id}/runtime/preflight`,
        }),
      );
      expect(preflight.statusCode, preflight.body).toBe(200);
      expect(preflight.json()).toMatchObject({
        ready: true,
        accountError: null,
        configured: ["CLAUDE_CODE_ACCOUNT"],
      });
      expect(await launchOf(agent.id, ctx.member)).toMatchObject({
        subscription: true,
        boundKeyIds: [],
      });
      // Their sign-in for this agent is read on the same runtime.
      const signIn = await as(ctx.member, () =>
        ctx.app.inject({
          method: "GET",
          url: `/api/agents/${agent.id}/runtime/claude-code/account`,
        }),
      );
      expect(signIn.statusCode, signIn.body).toBe(200);
      // The agent still stores no Claude account: the rule is not written.
      expect((await stored(agent.id)).runtime).not.toHaveProperty("claudeCode");
    });

    describe.each([
      {
        kind: "a maintained runtime with the company option only",
        runtimeName: "OpenCode",
        runtime: () => maintained("opencode"),
        rule: (accounts?: Rule) =>
          builtInWith("opencode", { ...(accounts && { accounts }) }),
      },
      {
        kind: "a custom runtime",
        runtimeName: "Engineering workspace",
        runtime: customRuntime,
        rule: (accounts?: Rule) => customWith(accounts),
      },
    ])("on $kind", ({ runtime, rule, runtimeName }) => {
      test("a fixed connection and model are what an existing agent's company option runs on, until the rule is cleared", async ({
        makeAgent,
      }) => {
        const { company, shared } = await openai();
        const agent = await makeAgent({
          organizationId: ctx.organizationId,
          authorId: ctx.admin.id,
          agentType: "agent",
          name: "Existing worker",
          ...pair(shared),
          runtime: { ...runtime(), accountLock: null },
        });
        const before = await stored(agent.id);
        const expectOn = async (connection: Connection, model: string) => {
          expect(await accountOf(agent.id, ctx.member)).toMatchObject({
            lock: null,
            agentAccount: { authentication: "provider", ...pair(connection) },
            companyKey: true,
          });
          expect(await preflightOf(agent.id, ctx.member)).toMatchObject({
            ready: true,
            accountError: null,
          });
          expect(await launchOf(agent.id, ctx.member)).toEqual({
            subscription: false,
            boundKeyIds: [connection.key.id],
            model,
          });
        };
        await expectOn(shared, "gpt-5.4-nano");

        await saved(rule(pair(company)));

        // A connection the person was never granted: the runtime's.
        await expectOn(company, "gpt-5.4");
        expect(await stored(agent.id)).toEqual(before);

        await saved(rule());

        await expectOn(shared, "gpt-5.4-nano");
      });

      test("with a connection fixed and no model, an agent keeps its own model only if it is one of the connection's", async ({
        makeAgent,
      }) => {
        const { company, secondModelId, shared } = await openai();
        const [onItsModel, onAnother] = await Promise.all(
          [secondModelId, shared.model.id].map((modelId, index) =>
            makeAgent({
              organizationId: ctx.organizationId,
              authorId: ctx.admin.id,
              agentType: "agent",
              name: `Existing worker ${index}`,
              llmApiKeyId: shared.key.id,
              modelId,
              runtime: { ...runtime(), accountLock: null },
            }),
          ),
        );
        await saved(rule({ llmApiKeyId: company.key.id }));

        expect(await preflightOf(onItsModel.id, ctx.member)).toMatchObject({
          ready: true,
        });
        expect(await launchOf(onItsModel.id, ctx.member)).toEqual({
          subscription: false,
          boundKeyIds: [company.key.id],
          model: "gpt-5.4-mini",
        });

        // No pod starts on a model the connection does not serve, and no
        // other connection stands in.
        const needsModel = `This agent's model is not available through the connection the ${runtimeName} runtime runs its agents on. Someone who can edit the agent must choose another model.`;
        expect(await preflightOf(onAnother.id, ctx.member)).toMatchObject({
          ready: false,
          accountError: needsModel,
          accountErrorFromChoice: false,
        });
        await expect(launchOf(onAnother.id, ctx.member)).rejects.toMatchObject({
          statusCode: 409,
          message: needsModel,
        });
        expect(await accountOf(onAnother.id, ctx.member)).toMatchObject({
          agentAccount: { llmApiKeyId: company.key.id, modelId: null },
          companyKey: false,
        });
      });
    });
  });

  // The Claude account a runtime's settings held before rules existed, and
  // still hold where no rule was set: the maintained Claude Code runtime's
  // stored one, the own of a custom image that runs Claude Code.
  describe.each([
    ["the maintained Claude Code runtime", "provider", "maintained"],
    ["the maintained Claude Code runtime", "subscription", "maintained"],
    ["a custom Claude runtime", "provider", "custom"],
    ["a custom Claude runtime", "subscription", "custom"],
  ] as const)("is not the Claude account %s stores without one (%s)", (_name, legacy, which) => {
    const other = legacy === "provider" ? "subscription" : "provider";
    // A custom image whose command is the maintained Claude Code one.
    const workspace = makeTemplate({
      name: "Claude workspace",
      position: 2,
      runtime: {
        ...makeTemplate().runtime,
        image: "example.com/claude-workspace:latest",
        command: ["archestra-claude-code"],
        inferenceProtocol: "anthropic",
        claudeCode: { authentication: legacy },
      },
    });
    let anthropic: Awaited<ReturnType<typeof connections>>;

    /** The runtime's settings are saved with its Claude account and no rule. */
    const store = (settings: { ttlHours?: number } = {}) =>
      saved(
        which === "maintained"
          ? builtInWith("claude-code", {
              ...settings,
              claudeCode: { authentication: legacy },
            })
          : {
              templates: [
                custom,
                {
                  ...workspace,
                  runtime: { ...workspace.runtime, ...settings },
                },
              ],
            },
      );
    /** An agent's runtime here that names a Claude account and a lock. */
    const onRuntime = (own: {
      authentication?: "provider" | "subscription";
      accountLock?: AgentRuntime["accountLock"];
    }) => {
      const base =
        which === "maintained" ? maintained("claude-code") : workspace.runtime;
      const { claudeCode, ...unnamed } = base;
      return {
        ...unnamed,
        ...(own.authentication && {
          claudeCode: { ...claudeCode, authentication: own.authentication },
        }),
        ...(own.accountLock !== undefined && { accountLock: own.accountLock }),
      } as AgentRuntime;
    };
    beforeEach(async () => {
      anthropic = await connections("anthropic", [
        "claude-sonnet-4-5",
        "claude-opus-4-5",
        "claude-haiku-4-5",
      ]);
      await store();
    });

    test("a builder gives their agent either Claude account and any lock, stored as sent", async () => {
      ctx.caller = ctx.member;
      const sent = [
        { authentication: other, accountLock: null },
        { authentication: legacy, accountLock: null },
        { authentication: "provider", accountLock: "key" },
        { authentication: "subscription", accountLock: "subscription" },
      ] as const;
      const ids: string[] = [];
      for (const own of sent) {
        const created = await create({
          runtime: onRuntime(own),
          ...pair(anthropic.shared),
        });
        expect(created.statusCode, created.body).toBe(200);
        ids.push(created.json().id);
        expect(await stored(created.json().id)).toMatchObject({
          ...pair(anthropic.shared),
          runtime: {
            claudeCode: { authentication: own.authentication },
            accountLock: own.accountLock,
          },
        });
      }

      // A lock and a Claude account they named stay theirs to change.
      for (const own of [sent[2], sent[3], sent[0]]) {
        const changed = await update(ids[0], { runtime: onRuntime(own) });
        expect(changed.statusCode, changed.body).toBe(200);
        expect(await stored(ids[0])).toMatchObject({
          runtime: {
            claudeCode: { authentication: own.authentication },
            accountLock: own.accountLock,
          },
        });
      }
      // Their copy is a new agent of theirs: each person chooses.
      const copied = await copy(ids[2]);
      expect(copied.statusCode, copied.body).toBe(200);
      expect(await stored(copied.json().id)).toMatchObject({
        runtime: {
          claudeCode: { authentication: "provider" },
          accountLock: null,
        },
      });
    });

    test("an existing agent on the other Claude account keeps running as it always did, for the account route, the preflight and the launch", async ({
      makeAgent,
    }) => {
      // Stored as before agents carried an account lock: none named.
      const agent = await makeAgent({
        organizationId: ctx.organizationId,
        authorId: ctx.admin.id,
        agentType: "agent",
        name: "On its own account",
        ...pair(anthropic.shared),
        runtime: onRuntime({ authentication: other }),
      });
      const before = await stored(agent.id);
      // It ran on its own account.
      const ranOn = other;
      const onItsOwn =
        ranOn === "subscription"
          ? { subscription: true, boundKeyIds: [] }
          : { subscription: false, boundKeyIds: [anthropic.shared.key.id] };

      // Saved again since, as the old dialog saved it.
      await store();

      for (const person of [ctx.member, ctx.admin]) {
        expect(await accountOf(agent.id, person)).toMatchObject({
          lock: ranOn === "subscription" ? "subscription" : "key",
          agentAccount: { authentication: ranOn },
        });
        expect(await preflightOf(agent.id, person)).toMatchObject({
          ready: true,
          accountError: null,
        });
        expect(await launchOf(agent.id, person)).toMatchObject(onItsOwn);
      }
      expect(await stored(agent.id)).toEqual(before);
    });

    test("a copy of an existing agent starts on the Claude account its source runs on", async ({
      makeAgent,
    }) => {
      // Stored as before agents carried an account lock: none named.
      const source = await makeAgent({
        organizationId: ctx.organizationId,
        authorId: ctx.member.id,
        agentType: "agent",
        name: "Source",
        ...pair(anthropic.shared),
        runtime: onRuntime({ authentication: other }),
      });
      ctx.caller = ctx.member;

      const copied = await copy(source.id);

      expect(copied.statusCode, copied.body).toBe(200);
      expect(await stored(copied.json().id)).toMatchObject({
        runtime: { claudeCode: { authentication: other } },
      });
    });
  });

  describe("leaves to the agent, then to each person, what it does not set of the company API key", () => {
    const pick = (
      agentId: string,
      user: User,
      parts: { llmApiKeyId?: string; modelId?: string },
    ) =>
      as(user, () =>
        ctx.app.inject({
          method: "PUT",
          url: `/api/agents/${agentId}/runtime/account`,
          payload: { authentication: "provider", ...parts },
        }),
      );
    const RUNTIME_SETS = (part: "connection" | "model") =>
      `This agent's runtime sets the ${part} of its company API key, so you cannot choose another.`;
    const AGENT_SETS_MODEL =
      "This agent sets the model of its company API key, so you cannot choose another.";

    test("the runtime sets the connection: the agent's model holds for everyone, and with none each person picks one of the connection's", async ({
      makeAgent,
    }) => {
      const { company, secondModelId, shared } = await openai();
      await saved(customWith({ llmApiKeyId: company.key.id }));
      const agent = await makeAgent({
        organizationId: ctx.organizationId,
        authorId: ctx.admin.id,
        agentType: "agent",
        runtime: customRuntime(),
      });
      const connection = {
        id: company.key.id,
        name: company.key.name,
        provider: "openai",
        fixedBy: "runtime",
      };

      // Nobody set the model: the person has one to pick, among the models
      // of a connection they may not read themselves.
      const open = await accountOf(agent.id, ctx.member);
      expect(open).toMatchObject({
        companyKey: false,
        companyAccount: {
          connection,
          model: { id: null, name: null, fixedBy: null },
          usesOrganizationDefault: false,
        },
      });
      expect(
        open.companyAccount.models.map((model: { id: string }) => model.id),
      ).toEqual(expect.arrayContaining([company.model.id, secondModelId]));
      expect(open.companyAccount.models).toHaveLength(2);
      expect(await preflightOf(agent.id, ctx.member)).toMatchObject({
        ready: false,
        accountError: "Choose a model on the agent's page to run this agent.",
        accountErrorFromChoice: false,
        accountErrorFromModel: true,
        accountErrorFromConnection: false,
      });
      const ownConnection = await pick(agent.id, ctx.member, {
        llmApiKeyId: shared.key.id,
        modelId: shared.model.id,
      });
      expect(ownConnection.statusCode).toBe(409);
      expect(ownConnection.json().error.message).toBe(
        RUNTIME_SETS("connection"),
      );
      const foreignModel = await pick(agent.id, ctx.member, {
        modelId: shared.model.id,
      });
      expect(foreignModel.statusCode).toBe(400);

      const picked = await pick(agent.id, ctx.member, {
        modelId: secondModelId,
      });
      expect(picked.statusCode, picked.body).toBe(200);
      expect(picked.json()).toMatchObject({
        companyKey: true,
        companyAccount: {
          connection,
          model: { id: secondModelId, name: "gpt-5.4-mini", fixedBy: null },
        },
      });
      expect(await launchOf(agent.id, ctx.member)).toEqual({
        subscription: false,
        boundKeyIds: [company.key.id],
        model: "gpt-5.4-mini",
      });
      // Their pick is theirs alone.
      expect(await preflightOf(agent.id, ctx.admin)).toMatchObject({
        ready: false,
        accountErrorFromModel: true,
      });

      // The agent's builder sets the model: it holds for everyone, whatever
      // they picked before.
      ctx.caller = ctx.admin;
      const built = await update(agent.id, { modelId: company.model.id });
      expect(built.statusCode, built.body).toBe(200);
      for (const person of [ctx.member, ctx.admin]) {
        const account = await accountOf(agent.id, person);
        expect(account).toMatchObject({
          companyKey: true,
          companyAccount: {
            connection,
            model: { id: company.model.id, name: "gpt-5.4", fixedBy: "agent" },
          },
        });
        expect(account.companyAccount).not.toHaveProperty("models");
        expect(await launchOf(agent.id, person)).toEqual({
          subscription: false,
          boundKeyIds: [company.key.id],
          model: "gpt-5.4",
        });
      }
      const overAgent = await pick(agent.id, ctx.member, {
        modelId: secondModelId,
      });
      expect(overAgent.statusCode).toBe(409);
      expect(overAgent.json().error.message).toBe(AGENT_SETS_MODEL);

      // The runtime sets the model too: its own, over the agent's.
      await saved(
        customWith({ llmApiKeyId: company.key.id, modelId: secondModelId }),
      );
      expect(await accountOf(agent.id, ctx.member)).toMatchObject({
        companyKey: true,
        companyAccount: {
          connection,
          model: { id: secondModelId, fixedBy: "runtime" },
        },
      });
      expect(await launchOf(agent.id, ctx.member)).toMatchObject({
        boundKeyIds: [company.key.id],
        model: "gpt-5.4-mini",
      });
      for (const [parts, message] of [
        [{ modelId: company.model.id }, RUNTIME_SETS("model")],
        [{ llmApiKeyId: shared.key.id }, RUNTIME_SETS("connection")],
      ] as const) {
        const refused = await pick(agent.id, ctx.member, parts);
        expect(refused.statusCode).toBe(409);
        expect(refused.json().error.message).toBe(message);
      }
    });

    test("the runtime sets nothing: the agent's connection holds for everyone, and each person picks its model", async ({
      makeAgent,
    }) => {
      const { company, secondModelId, shared } = await openai();
      // A rule that names no connection leaves it to the agent.
      await saved(builtInWith("codex", { accounts: { kind: "key" } }));
      const agent = await makeAgent({
        organizationId: ctx.organizationId,
        authorId: ctx.admin.id,
        agentType: "agent",
        llmApiKeyId: company.key.id,
        runtime: maintained("codex"),
      });

      expect(await accountOf(agent.id, ctx.member)).toMatchObject({
        lock: "key",
        companyKey: false,
        companyAccount: {
          connection: { id: company.key.id, fixedBy: "agent" },
          model: { id: null, fixedBy: null },
        },
      });
      const ownConnection = await pick(agent.id, ctx.member, {
        llmApiKeyId: shared.key.id,
      });
      expect(ownConnection.statusCode).toBe(409);
      expect(ownConnection.json().error.message).toBe(
        "This agent sets the connection of its company API key, so you cannot choose another.",
      );

      const picked = await pick(agent.id, ctx.member, {
        modelId: secondModelId,
      });

      expect(picked.statusCode, picked.body).toBe(200);
      expect(await launchOf(agent.id, ctx.member)).toEqual({
        subscription: false,
        boundKeyIds: [company.key.id],
        model: "gpt-5.4-mini",
      });
    });
  });

  describe("fixes a connection for the company API key alone", () => {
    test("with no kind named, a Codex agent stays on each person's ChatGPT and keeps its own model; the fixed connection is for whoever is on the company API key", async () => {
      const { company, shared } = await openai();
      // The person's own ChatGPT serves the agent's own model.
      const members = await makeKeyWithModel({
        organizationId: ctx.organizationId,
        provider: "openai",
        modelId: "gpt-5.4-nano",
        userId: ctx.member.id,
        apiKeyValue: "chatgpt-oauth:example-subscription",
      });
      ctx.caller = ctx.admin;
      const created = await create({
        runtime: { ...maintained("codex"), accountLock: null },
        ...pair(shared),
      });
      expect(created.statusCode, created.body).toBe(200);
      const id = created.json().id as string;
      const onTheirOwn = {
        subscription: false,
        boundKeyIds: [members.key.id],
        model: "gpt-5.4-nano",
      };
      const ownAccount = {
        agentAccount: { authentication: "subscription", ...pair(shared) },
        lock: null,
      };
      expect(await launchOf(id, ctx.member)).toEqual(onTheirOwn);
      expect(await accountOf(id, ctx.member)).toMatchObject(ownAccount);

      await saved(builtInWith("codex", { accounts: pair(company) }));

      expect(await launchOf(id, ctx.member)).toEqual(onTheirOwn);
      expect(await accountOf(id, ctx.member)).toMatchObject({
        ...ownAccount,
        companyAccount: companyAccountSetBy("runtime", company),
      });
      expect(await preflightOf(id, ctx.member)).toMatchObject({
        ready: true,
        accountError: null,
      });

      await choose(id, ctx.member, "provider");
      expect(await launchOf(id, ctx.member)).toEqual({
        subscription: false,
        boundKeyIds: [company.key.id],
        model: "gpt-5.4",
      });
    });
  });

  describe("fails closed when what it fixes no longer works", () => {
    const stillRunsOnASubscription = async (agentId: string) => {
      // A run on a person's own subscription needs no company option.
      await choose(agentId, ctx.member, "subscription");
      expect(await preflightOf(agentId, ctx.member)).toMatchObject({
        ready: true,
        accountError: null,
      });
      expect(await launchOf(agentId, ctx.member)).toMatchObject({
        subscription: true,
      });
    };

    test.each([
      {
        what: "deleted",
        breakIt: (company: Connection) =>
          LlmProviderApiKeyModel.delete(company.key.id),
        named: false,
      },
      {
        what: "turned into someone's own subscription",
        breakIt: (company: Connection) =>
          // Its value was replaced by a subscription credential.
          LlmProviderApiKeyModel.recordCredentialKind({
            id: company.key.id,
            apiKeyValue: "chatgpt-oauth:example-subscription",
          }),
        named: true,
      },
    ])("a fixed connection $what stops the company option, and never widens to the agent's own", async ({
      breakIt,
      named,
    }) => {
      const { company, shared } = await connections("anthropic", [
        "claude-sonnet-4-5",
        "claude-opus-4-5",
        "claude-haiku-4-5",
      ]);
      const agent = (
        await as(ctx.admin, () =>
          create({
            runtime: { ...maintained("claude-code"), accountLock: null },
            ...pair(shared),
          }),
        )
      ).json();
      await saved(builtInWith("claude-code", { accounts: pair(company) }));
      await choose(agent.id, ctx.member, "provider");
      expect(await launchOf(agent.id, ctx.member)).toMatchObject({
        boundKeyIds: [company.key.id],
      });

      await breakIt(company);

      const broken =
        "The connection the Claude Code runtime runs its agents on no longer works. Someone who can configure the runtime must choose another.";
      expect(await preflightOf(agent.id, ctx.member)).toMatchObject({
        ready: false,
        accountError: broken,
        accountErrorFromChoice: false,
      });
      await expect(launchOf(agent.id, ctx.member)).rejects.toMatchObject({
        statusCode: 409,
        message: broken,
      });
      const editor = await as(ctx.admin, () =>
        ctx.app.inject({
          method: "GET",
          url: "/api/agent-runtime-templates/settings",
        }),
      );
      expect(editor.json().builtIns["claude-code"].settings.accounts).toEqual({
        ...pair(company),
        keyMissing: true,
        ...(named && {
          keyName: company.key.name,
          keyProvider: "anthropic",
          modelName: "claude-sonnet-4-5",
        }),
        ...(!named && { modelName: "claude-sonnet-4-5" }),
      });
      await stillRunsOnASubscription(agent.id);
      // The runtime's other settings still save with the rule as it is.
      const resaved = await saved(
        builtInWith("claude-code", {
          ...editor.json().builtIns["claude-code"].settings,
          ttlHours: 6,
        }),
      );
      expect(resaved.builtIns["claude-code"].settings).toMatchObject({
        ttlHours: 6,
        accounts: { keyMissing: true },
      });
    });

    test("a fixed model deleted since stops the company option, and never widens to any model", async () => {
      const { company, shared } = await connections("anthropic", [
        "claude-sonnet-4-5",
        "claude-opus-4-5",
        "claude-haiku-4-5",
      ]);
      const agent = (
        await as(ctx.admin, () =>
          create({
            runtime: { ...maintained("claude-code"), accountLock: null },
            ...pair(shared),
          }),
        )
      ).json();
      await saved(builtInWith("claude-code", { accounts: pair(company) }));
      await choose(agent.id, ctx.member, "provider");

      await ModelModel.delete("anthropic", "claude-sonnet-4-5");

      const broken =
        "The model the Claude Code runtime runs its agents on no longer works. Someone who can configure the runtime must choose another.";
      expect(await preflightOf(agent.id, ctx.member)).toMatchObject({
        ready: false,
        accountError: broken,
      });
      await expect(launchOf(agent.id, ctx.member)).rejects.toMatchObject({
        statusCode: 409,
        message: broken,
      });
      const editor = await as(ctx.admin, () =>
        ctx.app.inject({
          method: "GET",
          url: "/api/agent-runtime-templates/settings",
        }),
      );
      expect(editor.json().builtIns["claude-code"].settings.accounts).toEqual({
        ...pair(company),
        keyName: company.key.name,
        keyProvider: "anthropic",
        modelMissing: true,
      });
      await stillRunsOnASubscription(agent.id);
    });
  });

  describe("and what a builder writes on an agent", () => {
    test("a named kind is written on no agent they create, copy or move: it locks the agent's runs while it stands, and no lock is theirs to name", async () => {
      const { secondModelId, shared } = await openai();
      const codex = maintained("codex");
      await saved(builtInWith("codex", { accounts: { kind: "key" } }));
      ctx.caller = ctx.member;

      // The agent stores what a new agent anywhere stores: each person
      // chooses. The rule is what holds its runs to a company API key.
      const noAccount = await create({ runtime: codex });
      expect(noAccount.statusCode, noAccount.body).toBe(200);
      expect(await stored(noAccount.json().id)).toMatchObject({
        llmApiKeyId: null,
        modelId: null,
        runtime: { accountLock: null },
      });
      const created = await create({ runtime: codex, ...pair(shared) });
      expect(created.statusCode, created.body).toBe(200);
      const id = created.json().id as string;
      expect(await stored(id)).toMatchObject({
        ...pair(shared),
        runtime: { accountLock: null },
      });
      expect(await accountOf(id, ctx.member)).toMatchObject({ lock: "key" });
      // Not even the kind the rule names: storing it would outlive the rule.
      for (const accountLock of ["subscription", "key"]) {
        const changed = await update(id, {
          runtime: { ...codex, accountLock },
        });
        expect(changed.statusCode, changed.body).toBe(403);
        expect(changed.json().error.message).toBe(
          "Only an administrator can lock the account of this agent.",
        );
        const named = await create({
          runtime: { ...codex, accountLock },
          ...pair(shared),
        });
        expect(named.statusCode, named.body).toBe(403);
        expect(named.json().error.message).toBe(
          "Only an administrator can lock the account of this agent.",
        );
      }

      const copied = await copy(id);
      expect(copied.statusCode, copied.body).toBe(200);
      expect(await stored(copied.json().id)).toMatchObject({
        llmApiKeyId: null,
        runtime: { accountLock: null },
      });
      expect(await accountOf(copied.json().id, ctx.member)).toMatchObject({
        lock: "key",
      });
      const elsewhere = await create({
        runtime: customRuntime(),
        ...pair(shared),
      });
      expect(await stored(elsewhere.json().id)).toMatchObject({
        runtime: { accountLock: null },
      });
      const moved = await update(elsewhere.json().id, { runtime: codex });
      expect(moved.statusCode, moved.body).toBe(200);
      expect(await stored(elsewhere.json().id)).toMatchObject({
        ...pair(shared),
        runtime: { accountLock: null },
      });
      expect(await accountOf(elsewhere.json().id, ctx.member)).toMatchObject({
        lock: "key",
      });

      // Their agent's own connection and model stay theirs to change.
      await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(shared.key.id, [
        secondModelId,
      ]);
      const remodelled = await update(id, { modelId: secondModelId });
      expect(remodelled.statusCode, remodelled.body).toBe(200);

      // An administrator is not refused on a write; the rule governs their
      // agent's runs all the same.
      ctx.caller = ctx.admin;
      const configured = await create({
        runtime: { ...codex, accountLock: null },
        ...pair(shared),
      });
      expect(configured.statusCode, configured.body).toBe(200);
      expect(await stored(configured.json().id)).toMatchObject({
        runtime: { accountLock: null },
      });
      expect(await accountOf(configured.json().id, ctx.admin)).toMatchObject({
        lock: "key",
      });
      // Not even a lock of the other kind on an agent with no connection,
      // which the rule's kind could not run: it is theirs to store.
      const otherKind = await create({
        runtime: { ...codex, accountLock: "subscription" },
      });
      expect(otherKind.statusCode, otherKind.body).toBe(200);
      expect(await stored(otherKind.json().id)).toMatchObject({
        runtime: { accountLock: "subscription" },
      });
    });

    test("with the kind left to each agent, they choose the agent's lock themselves", async () => {
      const { shared } = await openai();
      ctx.caller = ctx.member;

      const chosen = await create({
        runtime: { ...maintained("codex"), accountLock: "subscription" },
        ...pair(shared),
      });

      expect(chosen.statusCode, chosen.body).toBe(200);
      expect(await stored(chosen.json().id)).toMatchObject({
        runtime: { accountLock: "subscription" },
      });
      const unlocked = await update(chosen.json().id, {
        runtime: { ...maintained("codex"), accountLock: null },
      });
      expect(unlocked.statusCode, unlocked.body).toBe(200);
    });

    test("a connection the runtime fixes is never stored on an agent: a model alone is checked against it, and a connection they name by the ordinary rules", async () => {
      const { company, secondModelId, shared } = await openai();
      await saved(customWith({ llmApiKeyId: company.key.id }));
      ctx.caller = ctx.member;

      // No connection at all, and a model of the runtime's connection alone.
      const bare = await create({ runtime: customRuntime() });
      const onModel = await create({
        runtime: customRuntime(),
        modelId: secondModelId,
      });
      expect(bare.statusCode, bare.body).toBe(200);
      expect(onModel.statusCode, onModel.body).toBe(200);
      expect(await stored(bare.json().id)).toMatchObject({
        llmApiKeyId: null,
        modelId: null,
      });
      expect(await stored(onModel.json().id)).toMatchObject({
        llmApiKeyId: null,
        modelId: secondModelId,
      });
      expect(await launchOf(onModel.json().id, ctx.member)).toEqual({
        subscription: false,
        boundKeyIds: [company.key.id],
        model: "gpt-5.4-mini",
      });

      const foreignModel = await create({
        runtime: customRuntime(),
        modelId: shared.model.id,
      });
      expect(foreignModel.statusCode, foreignModel.body).toBe(400);
      expect(foreignModel.json().error.message).toBe(
        "The Engineering workspace runtime runs its agents on one connection, and the model you chose is not one of its models. Choose one of them.",
      );
      const remodelled = await update(onModel.json().id, {
        modelId: company.model.id,
      });
      expect(remodelled.statusCode, remodelled.body).toBe(200);
      expect(await stored(onModel.json().id)).toMatchObject({
        llmApiKeyId: null,
        modelId: company.model.id,
      });

      // A connection they name is judged as on a runtime that fixes none:
      // one shared with them is stored as theirs, the runtime's own, which
      // they were never granted, is refused.
      const own = await create({ runtime: customRuntime(), ...pair(shared) });
      expect(own.statusCode, own.body).toBe(200);
      expect(await stored(own.json().id)).toMatchObject(pair(shared));
      const named = await create({
        runtime: customRuntime(),
        ...pair(company),
      });
      expect(named.statusCode, named.body).toBe(400);
      expect(named.json().error.message).toBe(
        "The selected model and API key must be linked and available to you",
      );
      // Whatever it stores, its company option is the runtime's connection:
      // its own connection never runs, and its model is none of the
      // runtime connection's.
      await expect(launchOf(own.json().id, ctx.member)).rejects.toMatchObject({
        statusCode: 409,
        message:
          "This agent's model is not available through the connection the Engineering workspace runtime runs its agents on. Someone who can edit the agent must choose another model.",
      });

      // What that asks for: a model of the runtime's connection, sent alone
      // as the agent form sends it. The agent keeps its own connection,
      // which plays no part while the rule stands.
      const repaired = await update(own.json().id, {
        modelId: company.model.id,
      });
      expect(repaired.statusCode, repaired.body).toBe(200);
      expect(await stored(own.json().id)).toMatchObject({
        llmApiKeyId: shared.key.id,
        modelId: company.model.id,
      });
      expect(await launchOf(own.json().id, ctx.member)).toMatchObject({
        subscription: false,
        boundKeyIds: [company.key.id],
      });
      // A model sent alone is still one of the runtime connection's.
      const notOfRuntime = await update(own.json().id, {
        modelId: shared.model.id,
      });
      expect(notOfRuntime.statusCode).toBe(400);
      expect(notOfRuntime.json().error.message).toBe(
        "The Engineering workspace runtime runs its agents on one connection, and the model you chose is not one of its models. Choose one of them.",
      );
    });

    test("an agent created while a kind is named is free once the rule is removed, as an agent created before it is", async () => {
      await openai();
      const codex = maintained("codex");
      ctx.caller = ctx.member;
      const before = await create({ runtime: codex });
      expect(before.statusCode, before.body).toBe(200);

      ctx.caller = ctx.admin;
      await saved(builtInWith("codex", { accounts: { kind: "key" } }));
      ctx.caller = ctx.member;
      const during = await create({ runtime: codex });
      expect(during.statusCode, during.body).toBe(200);
      for (const id of [before.json().id, during.json().id]) {
        expect(await accountOf(id, ctx.member)).toMatchObject({ lock: "key" });
      }

      ctx.caller = ctx.admin;
      await saved(builtInWith("codex", { accounts: {} }));

      for (const id of [before.json().id, during.json().id]) {
        expect(await stored(id)).toMatchObject({
          runtime: { accountLock: null },
        });
        expect(await accountOf(id, ctx.member)).toMatchObject({ lock: null });
      }
    });

    test("under a named kind with a fixed connection and model, their agent stores nothing of the rule", async () => {
      const { company } = await openai();
      await saved(
        builtInWith("codex", { accounts: { kind: "key", ...pair(company) } }),
      );
      ctx.caller = ctx.member;

      const created = await create({ runtime: maintained("codex") });

      expect(created.statusCode, created.body).toBe(200);
      expect(await stored(created.json().id)).toMatchObject({
        llmApiKeyId: null,
        modelId: null,
        runtime: { accountLock: null },
      });
      expect(await launchOf(created.json().id, ctx.member)).toEqual({
        subscription: false,
        boundKeyIds: [company.key.id],
        model: "gpt-5.4",
      });
    });

    test("the runtime's connection is on no agent after a move off the runtime, a removed runtime, a copy, a restored version or a new owner", async ({
      makeUser,
      makeMember,
    }) => {
      const { company, secondModelId } = await openai();
      const elsewhere = makeTemplate({
        name: "Other workspace",
        position: 2,
        runtime: {
          ...custom.runtime,
          image: "registry.example.com/other-agent:v1",
        },
      });
      await saved({
        templates: [
          { ...custom, accounts: { llmApiKeyId: company.key.id } },
          elsewhere,
        ],
      });
      ctx.caller = ctx.member;
      const onRuntime = async () => {
        const created = await create({
          runtime: customRuntime(),
          modelId: company.model.id,
        });
        expect(created.statusCode, created.body).toBe(200);
        return created.json().id as string;
      };
      const neverTheRuntimeConnection = async (id: string) =>
        expect((await stored(id)).llmApiKeyId).toBeNull();

      const moved = await onRuntime();
      expect(
        (await update(moved, { runtime: elsewhere.runtime })).statusCode,
      ).toBe(200);
      await neverTheRuntimeConnection(moved);

      const removed = await onRuntime();
      expect((await update(removed, { runtime: null })).statusCode).toBe(200);
      await neverTheRuntimeConnection(removed);

      const source = await onRuntime();
      const copied = await copy(source);
      expect(copied.statusCode, copied.body).toBe(200);
      await neverTheRuntimeConnection(copied.json().id);

      // An earlier version holds a model alone, which is whole on this
      // runtime: it is restored as it was.
      const restored = await onRuntime();
      await AgentVersionModel.forkIfChanged(restored);
      const { data } = await AgentVersionModel.listForAgent({
        agentId: restored,
        organizationId: ctx.organizationId,
        pagination: { limit: 1, offset: 0 },
      });
      expect(
        (await update(restored, { modelId: secondModelId })).statusCode,
      ).toBe(200);
      const restore = await ctx.app.inject({
        method: "POST",
        url: `/api/agents/${restored}/versions/${data[0]?.version}/restore`,
        payload: {},
      });
      expect(restore.statusCode, restore.body).toBe(200);
      expect(await stored(restored)).toMatchObject({
        llmApiKeyId: null,
        modelId: company.model.id,
      });

      const transferred = await onRuntime();
      const newOwner = await makeUser();
      await makeMember(newOwner.id, ctx.organizationId, { role: "member" });
      ctx.caller = ctx.admin;
      const transfer = await ctx.app.inject({
        method: "POST",
        url: `/api/agents/${transferred}/transfer-ownership`,
        payload: { ownerId: newOwner.id },
      });
      expect(transfer.statusCode, transfer.body).toBe(200);
      await neverTheRuntimeConnection(transferred);
    });

    test("a whole agent sent back with only its name changed is accepted and changes nothing else", async () => {
      const { company, shared } = await openai();
      await saved(
        builtInWith("codex", { accounts: { kind: "key", ...pair(company) } }),
      );
      ctx.caller = ctx.member;
      const created = await create({
        runtime: maintained("codex"),
        ...pair(shared),
      });
      expect(created.statusCode, created.body).toBe(200);
      const id = created.json().id as string;
      const { updatedAt: _, ...before } = await stored(id);
      const read = (
        await ctx.app.inject({ method: "GET", url: `/api/agents/${id}` })
      ).json();

      const renamed = await update(id, {
        name: "Renamed",
        runtime: read.runtime,
        llmApiKeyId: read.llmApiKeyId,
        modelId: read.modelId,
      });

      expect(renamed.statusCode, renamed.body).toBe(200);
      expect((await AgentModel.findById(id))?.name).toBe("Renamed");
      expect(await stored(id)).toMatchObject(before);
    });

    test("under a lock, the same write through the REST route and the MCP tool is refused by both", async ({
      makeAgent,
    }) => {
      const { secondModelId, shared } = await openai();
      await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(shared.key.id, [
        secondModelId,
      ]);
      // Locked by an administrator on a locked runtime: there, an agent's
      // account is an administrator's to choose.
      const locked = makeTemplate({
        name: "Locked workspace",
        position: 3,
        locked: true,
        runtime: {
          ...custom.runtime,
          image: "registry.example.com/locked-agent:v1",
        },
      });
      await saved({ templates: [custom, locked] });
      const [throughRest, throughMcp] = await Promise.all(
        ["REST", "MCP"].map((path) =>
          makeAgent({
            organizationId: ctx.organizationId,
            authorId: ctx.member.id,
            agentType: "agent",
            name: `Written through ${path}`,
            ...pair(shared),
            runtime: { ...locked.runtime, accountLock: "key" },
          }),
        ),
      );
      // Another model of the connection the agent already stores.
      const write = { llmApiKeyId: shared.key.id, modelId: secondModelId };
      ctx.caller = ctx.member;

      const rest = await update(throughRest.id, write);
      const mcp = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}edit_agent`,
        { id: throughMcp.id, ...write },
        {
          agent: { id: throughMcp.id, name: throughMcp.name },
          userId: ctx.member.id,
          organizationId: ctx.organizationId,
        },
      );

      const refused =
        "This agent's account is locked. Only an administrator can change its account or runtime.";
      expect(rest.statusCode, rest.body).toBe(403);
      expect(rest.json().error.message).toBe(refused);
      expect(mcp.isError).toBe(true);
      expect(JSON.stringify(mcp.content)).toContain(refused);
      for (const { id } of [throughRest, throughMcp]) {
        expect(await stored(id)).toMatchObject(pair(shared));
      }
    });
  });

  test("saving a locked runtime writes nothing of its account rule on its agents", async ({
    makeAgent,
  }) => {
    const { company, shared } = await openai();
    const agents = await Promise.all(
      [
        {
          ...pair(shared),
          runtime: { ...maintained("codex"), accountLock: null },
        },
        { runtime: maintained("codex") },
      ].map((own, index) =>
        makeAgent({
          organizationId: ctx.organizationId,
          agentType: "agent",
          name: `Codex worker ${index}`,
          ...own,
        }),
      ),
    );
    const before = await Promise.all(agents.map(({ id }) => stored(id)));

    // A locked runtime writes its settings on every agent of its type.
    await saved({
      builtIns: {
        codex: {
          locked: true,
          settings: { accounts: { kind: "key", ...pair(company) } },
        },
      },
    });

    expect(await Promise.all(agents.map(({ id }) => stored(id)))).toEqual(
      before,
    );
    // The rule holds for them all the same.
    expect(await accountOf(agents[1].id, ctx.admin)).toMatchObject({
      lock: "key",
      agentAccount: pair(company),
    });
  });

  describe("is checked when the settings are saved", () => {
    test("a kind is for a runtime whose agents have two, and must agree with a Claude account the settings name", async () => {
      // A custom image whose command is the maintained Claude Code one.
      const claudeTemplate = {
        ...custom,
        runtime: {
          ...custom.runtime,
          command: ["archestra-claude-code"],
          inferenceProtocol: "anthropic",
          claudeCode: { authentication: "provider" },
        },
      };

      // Every runtime with two account kinds, the Claude ones included.
      for (const accepted of [
        builtInWith("codex", { accounts: { kind: "subscription" } }),
        builtInWith("claude-code", { accounts: { kind: "key" } }),
        builtInWith("claude-code", {
          claudeCode: { authentication: "subscription" },
          accounts: { kind: "subscription" },
        }),
        { templates: [{ ...claudeTemplate, accounts: { kind: "key" } }] },
      ]) {
        await saved(accepted);
      }

      const refused: [Parameters<typeof save>[0], string][] = [
        [
          builtInWith("opencode", { accounts: { kind: "key" } }),
          "The OpenCode runtime runs on a company API key only, so it has no account kind to name.",
        ],
        [
          customWith({ kind: "key" }),
          "The agents of the Engineering workspace runtime have one account kind, so there is none to name. Only a runtime whose command is the Claude Code or Codex wrapper has two.",
        ],
        [
          builtInWith("claude-code", {
            claudeCode: { authentication: "provider" },
            accounts: { kind: "subscription" },
          }),
          "The Claude Code runtime names each person's own subscription for its agents, but its Claude account is set to the other. Set both to the same account.",
        ],
        [
          {
            templates: [
              { ...claudeTemplate, accounts: { kind: "subscription" } },
            ],
          },
          "The Engineering workspace runtime names each person's own subscription for its agents, but its Claude account is set to the other. Set both to the same account.",
        ],
      ];
      for (const [patch, message] of refused) {
        expect(await refusal(patch), JSON.stringify(patch)).toBe(message);
      }
      const unknownKind = await save(
        builtInWith("codex", { accounts: { kind: "provider" } }),
      );
      expect(unknownKind.statusCode, unknownKind.body).toBe(400);
    });

    test("a connection must be a company one the person saving could pick for an agent of their own, and serve the runtime and the model", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeCustomRole,
    }) => {
      // Someone who may save the runtime settings; made before the
      // connections, as the people a connection is shared with are.
      const settingsEditor = await makeUser();
      const role = await makeCustomRole(ctx.organizationId, {
        permission: {
          organizationSettings: ["read", "update"],
          llmProviderApiKey: ["read"],
        },
      });
      await makeMember(settingsEditor.id, ctx.organizationId, {
        role: role.role,
      });
      const { company, shared } = await openai();
      const anthropic = await makeKeyWithModel({
        organizationId: ctx.organizationId,
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
      });
      const ownSubscription = await makeKeyWithModel({
        organizationId: ctx.organizationId,
        provider: "openai",
        modelId: "gpt-5.4",
        userId: ctx.admin.id,
        apiKeyValue: "chatgpt-oauth:example-subscription",
      });
      // An ordinary API key that belongs to another member.
      const anothersKey = await makeKeyWithModel({
        organizationId: ctx.organizationId,
        provider: "openai",
        modelId: "gpt-5.4",
        userId: ctx.member.id,
      });
      const elsewhere = await makeKeyWithModel({
        organizationId: (await makeOrganization()).id,
        provider: "openai",
        modelId: "gpt-5.4",
      });
      const personal =
        "The connection chosen for the Engineering workspace runtime is someone's personal one. Choose a company connection.";

      const refused: [Parameters<typeof save>[0], string][] = [
        [
          customWith({ modelId: company.model.id }),
          "Choose the connection of the Engineering workspace runtime before its model.",
        ],
        [customWith({ llmApiKeyId: ownSubscription.key.id }), personal],
        [customWith({ llmApiKeyId: anothersKey.key.id }), personal],
        [
          customWith({ llmApiKeyId: elsewhere.key.id }),
          "The connection chosen for the Engineering workspace runtime does not exist in this organization.",
        ],
        [
          customWith({
            llmApiKeyId: company.key.id,
            modelId: shared.model.id,
          }),
          "The model chosen for the Engineering workspace runtime is not one of the models of its connection.",
        ],
        [
          builtInWith("codex", { accounts: { llmApiKeyId: anthropic.key.id } }),
          "The connection or model chosen for the Codex runtime does not run on it. The maintained Codex runtime requires an OpenAI model, but the Agent's selected model uses Anthropic.",
        ],
        [
          builtInWith("codex", {
            accounts: { kind: "subscription", llmApiKeyId: company.key.id },
          }),
          "The Codex runtime runs on personal subscriptions only, so it has no company connection to fix.",
        ],
      ];
      for (const [patch, message] of refused) {
        expect(await refusal(patch), JSON.stringify(patch)).toBe(message);
      }

      // Someone who may save the settings but was never given the
      // administrators' connection cannot hand it to everyone.
      const current = await AgentRuntimeTemplateModel.getSettings(
        ctx.organizationId,
      );
      const asEditor = (accounts: Rule) =>
        as(settingsEditor, () =>
          ctx.app.inject({
            method: "PUT",
            url: "/api/agent-runtime-templates/settings",
            payload: { ...current, templates: [{ ...custom, accounts }] },
          }),
        );
      const notTheirs = await asEditor({ llmApiKeyId: company.key.id });
      expect(notTheirs.statusCode, notTheirs.body).toBe(403);
      expect(notTheirs.json().error.message).toBe(
        "You cannot use the connection chosen for the Engineering workspace runtime yourself, so you cannot give it to the runtime's agents. Choose a connection that is shared with you.",
      );
      expect(
        (await AgentRuntimeTemplateModel.getSettings(ctx.organizationId))
          .templates,
      ).toEqual([custom]);
      const theirs = await asEditor(pair(shared));
      expect(theirs.statusCode, theirs.body).toBe(200);
    });
  });

  describe("is read", () => {
    test("with the names of what it fixes and the models to pick from, by anyone who may configure an agent's runtime or the organization's settings, and by nobody else", async ({
      makeUser,
      makeMember,
      makeCustomRole,
    }) => {
      const { company, secondModelId } = await openai();
      const fixed = pair(company);
      const named = {
        keyName: company.key.name,
        keyProvider: "openai",
      };
      // Names sent back on a save are not part of it.
      const response = await saved({
        templates: [
          { ...custom, accounts: { ...fixed, keyName: "Forged name" } },
        ],
        builtIns: {
          codex: {
            locked: false,
            settings: { accounts: { llmApiKeyId: company.key.id } },
          },
        },
      });
      await drainBackgroundWork();
      const both = { ...fixed, ...named, modelName: "gpt-5.4" };
      // With no model fixed: the connection's models that run on the runtime.
      const connectionOnly = {
        llmApiKeyId: company.key.id,
        ...named,
        models: expect.arrayContaining([
          {
            id: company.model.id,
            modelId: "gpt-5.4",
            displayName: "gpt-5.4",
            provider: "openai",
          },
          {
            id: secondModelId,
            modelId: "gpt-5.4-mini",
            displayName: "gpt-5.4-mini",
            provider: "openai",
          },
        ]),
      };
      expect(response.templates[0].accounts).toEqual(both);
      expect(response.builtIns.codex.settings.accounts).toEqual(connectionOnly);
      expect(response.builtIns.codex.settings.accounts.models).toHaveLength(2);
      expect(
        (await AgentRuntimeTemplateModel.getSettings(ctx.organizationId))
          .templates[0].accounts,
      ).toEqual(fixed);

      const read = async (user: User, url: string) => {
        const reply = await as(user, () =>
          ctx.app.inject({ method: "GET", url }),
        );
        expect(reply.statusCode, reply.body).toBe(200);
        expect(reply.body).not.toContain("sk-test-company-key");
        return reply.json();
      };
      // Someone who was never granted the connection, but may configure an
      // agent's runtime, reads the same.
      expect(
        (await read(ctx.member, `/api/agent-runtime-templates/${custom.id}`))
          .accounts,
      ).toEqual(both);
      expect(
        (await read(ctx.member, "/api/agent-runtime-templates"))[0].accounts,
      ).toEqual(both);
      expect(
        await read(ctx.member, "/api/agent-runtime-templates/built-ins"),
      ).toEqual([
        { id: "codex", locked: false, settings: { accounts: connectionOnly } },
      ]);

      // Someone who may edit agents but not configure their runtime, and
      // someone who may do neither, read the runtimes without their rule.
      const editor = await makeUser();
      const role = await makeCustomRole(ctx.organizationId, {
        permission: { agent: ["read", "create", "update"] },
      });
      await makeMember(editor.id, ctx.organizationId, { role: role.role });
      for (const outsider of [editor, ctx.viewer]) {
        const listed = await read(outsider, "/api/agent-runtime-templates");
        expect(listed).toHaveLength(1);
        expect(listed[0]).not.toHaveProperty("accounts");
        expect(
          await read(outsider, "/api/agent-runtime-templates/built-ins"),
        ).toEqual([{ id: "codex", locked: false, settings: {} }]);
      }
    });

    test("and its save is audited with the ids and the kind, and nothing else", async () => {
      const { company } = await openai();
      const accounts = { kind: "key", ...pair(company) };

      await saved(builtInWith("codex", { accounts }));
      await drainBackgroundWork();

      const { data } = await AuditLogModel.findPaginated({
        organizationId: ctx.organizationId,
        resourceType: "organization",
        limit: 10,
        offset: 0,
      });
      expect(
        data
          .filter((item) => item.outcome === "success")
          .map(({ before, after }) => ({ before, after })),
      ).toEqual([
        {
          before: expect.objectContaining({ builtIns: {} }),
          after: expect.objectContaining({
            builtIns: { codex: { locked: false, settings: { accounts } } },
          }),
        },
      ]);
    });
  });
});
