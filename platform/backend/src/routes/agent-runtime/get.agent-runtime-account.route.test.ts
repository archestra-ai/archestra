import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  type SupportedProvider,
} from "@archestra/shared";
import { vi } from "vitest";
import { executeArchestraTool } from "@/archestra-mcp-server";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { agentSandboxApi } from "@/k8s/agent-runtime/sandbox-api";
import {
  AgentModel,
  AgentRuntimeUserAccountModel,
  LlmProviderApiKeyModel,
  ModelModel,
  OrganizationModel,
} from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { beforeEach, describe, expect, test } from "@/test";
import type { AgentRuntime, User } from "@/types";
import agentRoutes from "../agent";
import {
  buildAccountTestApp,
  companyAccountSetBy,
  makeKeyWithModel,
  NO_COMPANY_ACCOUNT,
  runtimeFor,
} from "./agent-runtime-account.test-helpers";

vi.mock("@/observability");

describe("GET /api/agents/:id/runtime/account", () => {
  const ctx = {} as { user: User; organizationId: string };
  let app: FastifyInstanceWithZod;

  beforeEach(async ({ makeMember, makeOrganization, makeUser }) => {
    ctx.organizationId = (await makeOrganization()).id;
    ctx.user = await makeUser();
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    app = await buildAccountTestApp(ctx);
    vi.spyOn(agentSandboxApi, "isInstalled", "get").mockReturnValue(true);
  });

  const read = (agentId: string) =>
    app.inject({
      method: "GET",
      url: `/api/agents/${agentId}/runtime/account`,
    });

  test("with no connection set or chosen, the company API key shows the shared company connection a run binds, not the reader's own key", async ({
    makeAgent,
  }) => {
    // The reader may use both. Their own key ranks first among their keys,
    // and is theirs to run on only by picking it.
    await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4",
      userId: ctx.user.id,
    });
    const shared = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4",
    });
    const agent = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      runtime: runtimeFor({ inferenceProtocol: "openai_chat" }),
    });

    expect((await read(agent.id)).json()).toMatchObject({
      companyKey: true,
      companyAccount: {
        connection: { id: shared.key.id, fixedBy: null },
        model: { id: shared.model.id, fixedBy: null },
        usesOrganizationDefault: true,
      },
    });
  });

  test("offers a Claude subscription on the maintained Claude Code runtime", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      runtime: runtimeFor({
        inferenceProtocol: "anthropic",
        command: ["archestra-claude-code"],
      }),
    });

    const response = await read(agent.id);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      agentAccount: {
        authentication: "subscription",
        llmApiKeyId: null,
        modelId: null,
      },
      companyKey: false,
      companyAccount: NO_COMPANY_ACCOUNT,
      choice: null,
      choiceError: null,
      lock: null,
      subscription: {
        kind: "claude",
        label: "Claude subscription",
        connected: false,
        keyId: null,
      },
    });
  });

  test("an agent saved before people could choose is held to the one way it runs", async ({
    makeAgent,
  }) => {
    const { accountLock: _, ...claudeRuntime } = runtimeFor({
      inferenceProtocol: "anthropic",
      command: ["archestra-claude-code"],
    });
    const onSubscriptions = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      runtime: claudeRuntime,
    });
    expect((await read(onSubscriptions.id)).json()).toMatchObject({
      agentAccount: { authentication: "subscription" },
      lock: "subscription",
    });

    const own = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4",
    });
    const { accountLock: __, ...openAiRuntime } = runtimeFor({
      inferenceProtocol: "openai_responses",
    });
    const onItsKey = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      runtime: openAiRuntime,
      llmApiKeyId: own.key.id,
      modelId: own.model.id,
    });
    // Everyone stays on the agent's own connection and model, as before.
    expect((await read(onItsKey.id)).json()).toMatchObject({
      agentAccount: { authentication: "provider", llmApiKeyId: own.key.id },
      companyKey: true,
      lock: "key",
    });

    // An agent on the organization's default key and model is a company-key
    // agent too: it is held to a company API key, and runs on the default
    // until a person picks a connection of their own.
    const onTheDefault = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      runtime: openAiRuntime,
    });
    expect((await read(onTheDefault.id)).json()).toMatchObject({
      agentAccount: {
        authentication: "provider",
        llmApiKeyId: null,
        modelId: null,
      },
      companyKey: true,
      companyAccount: {
        connection: { id: own.key.id, fixedBy: null },
        model: { id: own.model.id, fixedBy: null },
        usesOrganizationDefault: true,
      },
      lock: "key",
    });

    // The other way is not theirs to choose.
    const choose = (agentId: string, authentication: string) =>
      app.inject({
        method: "PUT",
        url: `/api/agents/${agentId}/runtime/account`,
        payload: { authentication },
      });
    const refused = await choose(onSubscriptions.id, "provider");
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toBe(
      "This agent is locked to each person's own subscription, so you cannot choose a company API key for it.",
    );
    for (const agentId of [onItsKey.id, onTheDefault.id]) {
      const refusedSubscription = await choose(agentId, "subscription");
      expect(refusedSubscription.statusCode).toBe(409);
      expect(refusedSubscription.json().error.message).toBe(
        "This agent is locked to a company API key, so you cannot choose a personal subscription for it.",
      );
    }
  });

  test("an agent saved before people could choose runs a connection it stores without a model as it always did: on the organization's default", async ({
    makeAgent,
  }) => {
    const openai = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4",
    });
    const anthropic = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
    await OrganizationModel.patch(ctx.organizationId, {
      defaultModelId: openai.model.id,
      defaultLlmApiKeyId: openai.key.id,
    });
    const { accountLock: _, ...saved } = runtimeFor({
      inferenceProtocol: "openai_chat",
    });
    const preflight = async (agentId: string) =>
      (
        await app.inject({
          method: "GET",
          url: `/api/agents/${agentId}/runtime/preflight`,
        })
      ).json();

    // A connection of another provider than the default's played no part in
    // its runs: the default ran, on the default's connection.
    const otherProvider = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      runtime: saved,
      llmApiKeyId: anthropic.key.id,
    });
    expect(await preflight(otherProvider.id)).toMatchObject({
      ready: true,
      incompatible: null,
      accountError: null,
    });
    expect((await read(otherProvider.id)).json()).toMatchObject({
      companyKey: true,
      companyAccount: {
        connection: { id: openai.key.id, fixedBy: null },
        model: { id: openai.model.id, fixedBy: null },
        usesOrganizationDefault: true,
      },
      lock: "key",
    });
    // The connection sets nothing, so each person may pick their own.
    const picked = await app.inject({
      method: "PUT",
      url: `/api/agents/${otherProvider.id}/runtime/account`,
      payload: {
        authentication: "provider",
        llmApiKeyId: anthropic.key.id,
        modelId: anthropic.model.id,
      },
    });
    expect(picked.statusCode, picked.body).toBe(200);
    expect(picked.json().companyAccount).toMatchObject({
      connection: { id: anthropic.key.id, fixedBy: null },
      model: { id: anthropic.model.id, fixedBy: null },
    });

    // One of the default's provider: the default runs on it.
    const defaultProvider = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      runtime: saved,
      llmApiKeyId: openai.key.id,
    });
    expect(await preflight(defaultProvider.id)).toMatchObject({
      ready: true,
      accountError: null,
    });
    expect((await read(defaultProvider.id)).json()).toMatchObject({
      companyKey: true,
      companyAccount: {
        connection: { id: openai.key.id, fixedBy: null },
        model: { id: openai.model.id, fixedBy: null },
        usesOrganizationDefault: true,
      },
    });
  });

  test("saves an agent saved before people could choose whose connection without a model plays no part in its runs", async ({
    makeAgent,
  }) => {
    await app.register(agentRoutes);
    // An agent of an Anthropic image on an OpenAI key whose model was
    // deleted since: its runs take the organization's default, so the
    // connection, which the image cannot run, is not judged.
    const openai = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4",
    });
    const anthropic = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
    await OrganizationModel.patch(ctx.organizationId, {
      defaultModelId: anthropic.model.id,
      defaultLlmApiKeyId: anthropic.key.id,
    });
    const { accountLock: _, ...saved } = runtimeFor({
      inferenceProtocol: "anthropic",
    });
    const agent = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      runtime: saved,
      llmApiKeyId: openai.key.id,
    });

    const resaved = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}`,
      payload: { runtime: { ...saved, ttlHours: 4 } },
    });

    expect(resaved.statusCode, resaved.body).toBe(200);
    expect((await AgentModel.findById(agent.id))?.runtime).toMatchObject({
      ttlHours: 4,
    });
    expect((await AgentModel.findById(agent.id))?.runtime).not.toHaveProperty(
      "accountLock",
    );
  });

  test("says whether the caller can run on the company API key", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const companyKeyOf = async (
      account: { llmApiKeyId?: string; modelId?: string },
      command: string[] | null = null,
    ) => {
      const agent = await makeAgent({
        organizationId: ctx.organizationId,
        authorId: ctx.user.id,
        agentType: "agent",
        ...account,
        runtime: runtimeFor({ inferenceProtocol: "openai_responses", command }),
      });
      const response = await read(agent.id);
      expect(response.statusCode, response.body).toBe(200);
      return response.json().companyKey;
    };
    // With no connection anywhere in the organization, nothing resolves.
    expect(await companyKeyOf({})).toBe(false);

    const company = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4",
    });
    const unlinked = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4-mini",
    });
    const personal = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4-personal",
      userId: ctx.user.id,
      apiKeyValue: "chatgpt-oauth:example-subscription",
    });
    const foreign = await makeKeyWithModel({
      organizationId: (await makeOrganization()).id,
      provider: "openai",
      modelId: "gpt-5.4-foreign",
    });
    const gemini = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "gemini",
      modelId: "gemini-2.5-pro",
    });

    expect(
      await companyKeyOf({
        llmApiKeyId: company.key.id,
        modelId: company.model.id,
      }),
    ).toBe(true);
    // The maintained Codex runtime can run on the agent's OpenAI key too.
    expect(
      await companyKeyOf(
        { llmApiKeyId: company.key.id, modelId: company.model.id },
        ["archestra-codex"],
      ),
    ).toBe(true);
    // With nothing set, a connection the caller may use resolves by default.
    expect(await companyKeyOf({})).toBe(true);
    // A model stands for nothing without its connection.
    expect(await companyKeyOf({ modelId: company.model.id })).toBe(true);
    // A connection set without a model: the caller has one to pick first.
    expect(await companyKeyOf({ llmApiKeyId: company.key.id })).toBe(false);
    // A model its key does not serve.
    expect(
      await companyKeyOf({
        llmApiKeyId: company.key.id,
        modelId: unlinked.model.id,
      }),
    ).toBe(false);
    // Someone's personal subscription is never a company key.
    expect(
      await companyKeyOf({
        llmApiKeyId: personal.key.id,
        modelId: personal.model.id,
      }),
    ).toBe(false);
    expect(
      await companyKeyOf({
        llmApiKeyId: foreign.key.id,
        modelId: foreign.model.id,
      }),
    ).toBe(false);
    // A key the runtime cannot run on.
    expect(
      await companyKeyOf(
        { llmApiKeyId: gemini.key.id, modelId: gemini.model.id },
        ["archestra-codex"],
      ),
    ).toBe(false);
  });

  test("offers a Claude subscription on no custom image and not on the Claude Code wrapper, whatever Claude account they store", async ({
    makeAgent,
  }) => {
    for (const runtime of [
      { command: ["custom-claude-entrypoint"], authentication: "provider" },
      { command: ["custom-claude-entrypoint"], authentication: "subscription" },
      {
        command: ["archestra-claude-code-runtime"],
        authentication: "subscription",
      },
    ] as const) {
      const agent = await makeAgent({
        organizationId: ctx.organizationId,
        authorId: ctx.user.id,
        agentType: "agent",
        runtime: runtimeFor({
          inferenceProtocol: "anthropic",
          command: [...runtime.command],
          claudeCode: { authentication: runtime.authentication },
        }),
      });

      expect(
        (await read(agent.id)).json(),
        `${runtime.command[0]} on ${runtime.authentication}`,
      ).toMatchObject({
        agentAccount: { authentication: "provider" },
        subscription: null,
      });
    }
  });

  test("offers ChatGPT on the maintained Codex runtime and sees the caller's sign-in", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      runtime: runtimeFor({
        inferenceProtocol: "openai_responses",
        command: ["archestra-codex"],
      }),
    });
    expect((await read(agent.id)).json()).toMatchObject({
      agentAccount: { authentication: "subscription" },
      subscription: {
        kind: "chatgpt",
        label: "ChatGPT Subscription",
        connected: false,
        keyId: null,
      },
    });

    const { key } = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4",
      userId: ctx.user.id,
      apiKeyValue: "chatgpt-oauth:example-subscription",
    });

    expect((await read(agent.id)).json()).toMatchObject({
      subscription: { kind: "chatgpt", connected: true, keyId: key.id },
    });
  });

  test("the preflight asks for ChatGPT on the maintained Codex runtime until it is connected", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      runtime: runtimeFor({
        inferenceProtocol: "openai_responses",
        command: ["archestra-codex"],
      }),
    });
    const preflight = () =>
      app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/runtime/preflight`,
      });

    const before = await preflight();
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json()).toMatchObject({
      ready: false,
      accountError:
        "Connect your own ChatGPT Subscription before starting this Agent. The maintained runtime never falls back to usage-based API billing.",
      accountErrorFromChoice: false,
      // Named, so every surface can say "Sign in with ChatGPT" the same way.
      missingSubscription: "chatgpt",
    });

    await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4",
      userId: ctx.user.id,
      apiKeyValue: "chatgpt-oauth:example-subscription",
    });

    expect((await preflight()).json()).toMatchObject({
      accountError: null,
      missingSubscription: null,
    });
  });

  test("a subscription lock makes the agent's own account a subscription only on a runtime that has one", async ({
    makeAgent,
  }) => {
    // Each agent stores a company key; only the lock says "subscription".
    const ownAccountOf = async (params: {
      provider: SupportedProvider;
      modelId: string;
      command: string[];
    }) => {
      const { key, model } = await makeKeyWithModel({
        organizationId: ctx.organizationId,
        provider: params.provider,
        modelId: params.modelId,
      });
      const agent = await makeAgent({
        organizationId: ctx.organizationId,
        authorId: ctx.user.id,
        agentType: "agent",
        llmApiKeyId: key.id,
        modelId: model.id,
        runtime: runtimeFor({
          inferenceProtocol: "openai_chat",
          command: params.command,
          accountLock: "subscription",
        }),
      });
      const response = await read(agent.id);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        agentAccount: { llmApiKeyId: key.id, modelId: model.id },
        lock: "subscription",
      });
      return response.json().agentAccount.authentication;
    };

    expect(
      await ownAccountOf({
        provider: "openai",
        modelId: "gpt-5.4",
        command: ["archestra-codex"],
      }),
    ).toBe("subscription");
    // OpenCode has no subscription of its own: the stored key still decides.
    expect(
      await ownAccountOf({
        provider: "xai",
        modelId: "grok-4.3",
        command: ["archestra-opencode"],
      }),
    ).toBe("provider");
  });

  test("offers no subscription on a runtime that has none, whatever its model's provider", async ({
    makeAgent,
  }) => {
    // The caller has connected both subscriptions these providers sell: the
    // runtime decides, so neither is offered.
    for (const [provider, modelId, apiKeyValue] of [
      ["openai", "gpt-5.4-own", "chatgpt-oauth:example-subscription"],
      ["xai", "grok-4.3-own", "xai-subscription:example-subscription"],
    ] as const) {
      await makeKeyWithModel({
        organizationId: ctx.organizationId,
        provider,
        modelId,
        userId: ctx.user.id,
        apiKeyValue,
      });
    }
    const cases: Array<{
      provider: SupportedProvider;
      modelId: string;
      command: string[] | null;
    }> = [
      {
        provider: "openai",
        modelId: "gpt-5.4",
        command: ["archestra-opencode"],
      },
      { provider: "xai", modelId: "grok-4.3", command: ["archestra-opencode"] },
      // A custom image that does not declare Claude Code.
      { provider: "openai", modelId: "gpt-5.4", command: ["my-agent"] },
      { provider: "xai", modelId: "grok-4.3", command: null },
    ];
    for (const { provider, modelId, command } of cases) {
      const company = await makeKeyWithModel({
        organizationId: ctx.organizationId,
        provider,
        modelId,
      });
      const { key, model } = company;
      const agent = await makeAgent({
        organizationId: ctx.organizationId,
        authorId: ctx.user.id,
        agentType: "agent",
        llmApiKeyId: key.id,
        modelId: model.id,
        runtime: runtimeFor({ inferenceProtocol: "openai_chat", command }),
      });

      const response = await read(agent.id);

      expect(
        response.json(),
        `${provider} on ${command?.[0] ?? "no command"}`,
      ).toEqual({
        agentAccount: {
          authentication: "provider",
          llmApiKeyId: key.id,
          modelId: model.id,
        },
        companyKey: true,
        companyAccount: companyAccountSetBy("agent", company),
        choice: null,
        choiceError: null,
        lock: null,
        subscription: null,
      });
    }
  });

  test("returns only the caller's own choice", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    const { key, model } = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4",
    });
    const agent = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      llmApiKeyId: key.id,
      modelId: model.id,
      runtime: runtimeFor({ inferenceProtocol: "openai_responses" }),
    });
    await AgentRuntimeUserAccountModel.upsert({
      agentId: agent.id,
      userId: ctx.user.id,
      authentication: "provider",
      modelId: null,
    });
    const colleague = await makeUser();
    await makeMember(colleague.id, ctx.organizationId, { role: "member" });

    // The agent's company key and model: the choice names neither.
    expect((await read(agent.id)).json()).toMatchObject({
      choice: { authentication: "provider", modelId: null },
      choiceError: null,
    });
    ctx.user = colleague;
    expect((await read(agent.id)).json().choice).toBeNull();
  });

  // A choice that no longer runs is returned as stored, with what the
  // person is to do about it.
  test("returns a choice of the company API key as stored while what the agent sets changes under it", async ({
    makeAgent,
  }) => {
    const own = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4-stale-test",
    });
    const agent = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      llmApiKeyId: own.key.id,
      modelId: own.model.id,
      runtime: runtimeFor({ inferenceProtocol: "openai_responses" }),
    });
    await AgentRuntimeUserAccountModel.upsert({
      agentId: agent.id,
      userId: ctx.user.id,
      authentication: "provider",
      modelId: null,
    });
    const choice = {
      authentication: "provider",
      llmApiKeyId: null,
      modelId: null,
    };
    const preflight = async () =>
      (
        await app.inject({
          method: "GET",
          url: `/api/agents/${agent.id}/runtime/preflight`,
        })
      ).json();
    expect((await read(agent.id)).json()).toMatchObject({
      companyKey: true,
      choice,
      choiceError: null,
    });
    expect(await preflight()).toMatchObject({ accountError: null });

    // The agent's model is removed: its connection stays set for everyone,
    // and its model is now each person's to pick, not a broken choice.
    await ModelModel.delete("openai", "gpt-5.4-stale-test");
    expect((await read(agent.id)).json()).toMatchObject({
      companyKey: false,
      companyAccount: {
        connection: { id: own.key.id, fixedBy: "agent" },
        model: { id: null, fixedBy: null },
        models: [],
        usesOrganizationDefault: false,
      },
      choice,
      choiceError: null,
    });
    expect(await preflight()).toMatchObject({
      ready: false,
      accountError: "Choose a model on the agent's page to run this agent.",
      accountErrorFromChoice: false,
      accountErrorFromModel: true,
      accountErrorFromConnection: false,
    });

    // The agent is given someone's personal subscription instead.
    const personal = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4",
      userId: ctx.user.id,
      apiKeyValue: "chatgpt-oauth:example-subscription",
    });
    await AgentModel.update(agent.id, {
      llmApiKeyId: personal.key.id,
      modelId: personal.model.id,
    });
    expect((await read(agent.id)).json()).toMatchObject({
      companyKey: false,
      choice,
      choiceError:
        "Your own account for this agent no longer works. The agent's own key is a personal subscription, not a company API key. Choose your account again.",
    });

    // A removed key leaves the agent with no connection: the person is on
    // the organization's default again, which here gives none.
    await LlmProviderApiKeyModel.delete(personal.key.id);
    await LlmProviderApiKeyModel.delete(own.key.id);
    const response = await read(agent.id);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      companyKey: false,
      companyAccount: NO_COMPANY_ACCOUNT,
      choice,
      choiceError: null,
    });
    expect(await preflight()).toMatchObject({
      ready: false,
      accountError:
        "Choose a connection on the agent's page to run this agent.",
      accountErrorFromChoice: false,
      accountErrorFromModel: false,
      accountErrorFromConnection: true,
    });
  });

  test("reports the lock and a choice the lock sets aside", async ({
    makeAgent,
  }) => {
    const own = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4",
    });
    // The maintained Codex runtime offers both ways, so either choice could
    // be saved before the lock, and either lock fits its company key.
    const lockedTo = (accountLock: "key" | "subscription") =>
      makeAgent({
        organizationId: ctx.organizationId,
        authorId: ctx.user.id,
        agentType: "agent",
        llmApiKeyId: own.key.id,
        modelId: own.model.id,
        runtime: runtimeFor({
          inferenceProtocol: "openai_responses",
          command: ["archestra-codex"],
          accountLock,
        }),
      });
    // Saved before the agent was locked.
    const chose = (
      agentId: string,
      authentication: "subscription" | "provider",
    ) =>
      AgentRuntimeUserAccountModel.upsert({
        agentId,
        userId: ctx.user.id,
        authentication,
        modelId: null,
      });

    const byKey = await lockedTo("key");
    await chose(byKey.id, "subscription");
    expect((await read(byKey.id)).json()).toMatchObject({
      lock: "key",
      choice: { authentication: "subscription", modelId: null },
      choiceError:
        "This agent is locked to a company API key, so your own choice is not used.",
    });

    const bySubscription = await lockedTo("subscription");
    await chose(bySubscription.id, "provider");
    expect((await read(bySubscription.id)).json()).toMatchObject({
      lock: "subscription",
      choice: { authentication: "provider", modelId: null },
      choiceError:
        "This agent is locked to each person's own subscription, so your own choice is not used.",
    });
  });

  test("does not report a company-key choice as set aside by a key lock", async ({
    makeAgent,
  }) => {
    const own = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4",
    });
    const agent = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      llmApiKeyId: own.key.id,
      modelId: own.model.id,
      runtime: runtimeFor({
        inferenceProtocol: "openai_responses",
        accountLock: "key",
      }),
    });
    // The agent's company key is what the lock gives everyone anyway.
    await AgentRuntimeUserAccountModel.upsert({
      agentId: agent.id,
      userId: ctx.user.id,
      authentication: "provider",
      modelId: null,
    });

    expect((await read(agent.id)).json()).toMatchObject({
      lock: "key",
      companyKey: true,
      choice: { authentication: "provider", modelId: null },
      choiceError: null,
    });
    const preflight = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/runtime/preflight`,
    });
    expect(preflight.json()).toMatchObject({ ready: true, accountError: null });
  });

  test("tells a lock problem from a choice the person can redo", async ({
    makeAgent,
  }) => {
    const own = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "gemini",
      modelId: "gemini-2.5-pro",
    });
    // A subscription lock on a model with no personal subscription.
    const agent = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      llmApiKeyId: own.key.id,
      modelId: own.model.id,
      runtime: runtimeFor({
        inferenceProtocol: "openai_chat",
        accountLock: "subscription",
      }),
    });

    const preflight = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/runtime/preflight`,
    });
    expect(preflight.json()).toMatchObject({
      ready: false,
      accountError: expect.stringContaining(
        "Someone who can configure its runtime must change its model or its lock.",
      ),
      accountErrorFromChoice: false,
    });
  });

  test("the preflight is not ready for a key lock whose key a run would refuse to bind", async ({
    makeAgent,
  }) => {
    // The pinned key now carries someone's own ChatGPT sign-in: the pair is
    // still stored and linked, and only binding it finds the lock broken.
    const replaced = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4",
      userId: ctx.user.id,
      apiKeyValue: "chatgpt-oauth:example-subscription",
    });
    const agent = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      llmApiKeyId: replaced.key.id,
      modelId: replaced.model.id,
      runtime: runtimeFor({
        inferenceProtocol: "openai_chat",
        accountLock: "key",
      }),
    });

    const preflight = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/runtime/preflight`,
    });

    expect(preflight.json()).toMatchObject({
      ready: false,
      accountError:
        "This agent is locked to a company API key, but this run would use a personal subscription. Someone who can configure its runtime must change its account or its lock.",
      accountErrorFromChoice: false,
      accountErrorFromModel: false,
      missingSubscription: null,
    });
  });

  test("keeps a problem of the agent's own account out of the choice error", async ({
    makeAgent,
  }) => {
    const own = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4-locked-pair-test",
    });
    const other = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4-mini",
    });
    // Locked to a company API key, with a model its key does not serve.
    const agent = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      llmApiKeyId: own.key.id,
      modelId: other.model.id,
      runtime: runtimeFor({
        inferenceProtocol: "openai_chat",
        accountLock: "key",
      }),
    });
    const brokenPair =
      "This agent is locked to a company API key, but its own API key no longer serves its model. Someone who can edit the agent must choose them again.";
    const choose = (authentication: "provider" | "subscription") =>
      AgentRuntimeUserAccountModel.upsert({
        agentId: agent.id,
        userId: ctx.user.id,
        authentication,
        modelId: null,
      });

    // A company-key row is what the lock gives anyway: nothing to report.
    await choose("provider");
    expect((await read(agent.id)).json()).toMatchObject({
      lock: "key",
      companyKey: false,
      choiceError: null,
    });

    // A subscription row is set aside by the lock, and only that is said.
    await choose("subscription");
    expect((await read(agent.id)).json()).toMatchObject({
      lock: "key",
      choiceError:
        "This agent is locked to a company API key, so your own choice is not used.",
    });
    const preflight = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/runtime/preflight`,
    });
    expect(preflight.json()).toMatchObject({
      ready: false,
      accountError: brokenPair,
      accountErrorFromChoice: false,
      accountErrorFromModel: false,
      accountErrorFromConnection: false,
    });
  });

  // An agent that sets nothing of its company API key, on a runtime the
  // organization's default cannot run on.
  describe.each([
    {
      runtimeName: "the maintained Codex runtime locked to a company API key",
      runtime: (): AgentRuntime =>
        runtimeFor({
          inferenceProtocol: "openai_responses",
          command: ["archestra-codex"],
          accountLock: "key",
        }),
      fits: { provider: "openai", modelId: "gpt-5.4" },
      unfit: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
    },
    {
      runtimeName: "the maintained Claude Code runtime on a company API key",
      runtime: (): AgentRuntime =>
        runtimeFor({
          inferenceProtocol: "anthropic",
          command: ["archestra-claude-code"],
          claudeCode: { authentication: "provider" },
        }),
      fits: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
      unfit: { provider: "openai", modelId: "gpt-5.4" },
    },
  ] as const)("an organization default on $runtimeName", ({
    runtime,
    fits,
    unfit,
  }) => {
    let fitting: Awaited<ReturnType<typeof makeKeyWithModel>>;
    let other: Awaited<ReturnType<typeof makeKeyWithModel>>;

    beforeEach(async () => {
      await app.register(agentRoutes);
      fitting = await makeKeyWithModel({
        organizationId: ctx.organizationId,
        ...fits,
      });
      other = await makeKeyWithModel({
        organizationId: ctx.organizationId,
        ...unfit,
      });
    });

    const defaultTo = (set: typeof fitting) =>
      OrganizationModel.patch(ctx.organizationId, {
        defaultModelId: set.model.id,
        defaultLlmApiKeyId: set.key.id,
      });
    /** An agent whose builder sets no connection and no model. */
    const createEmpty = async () => {
      const created = await app.inject({
        method: "POST",
        url: "/api/agents",
        payload: { agentType: "agent", name: "Worker", runtime: runtime() },
      });
      expect(created.statusCode, created.body).toBe(200);
      expect(created.json()).toMatchObject({
        llmApiKeyId: null,
        modelId: null,
      });
      return created.json().id as string;
    };
    const preflight = async (agentId: string) =>
      (
        await app.inject({
          method: "GET",
          url: `/api/agents/${agentId}/runtime/preflight`,
        })
      ).json();

    test("that the runtime cannot run counts as none: the agent saves, and its runs wait for a connection", async () => {
      await defaultTo(other);

      // Nothing was chosen, so nothing is refused: through the API, through
      // a later change of the runtime alone, and through the MCP tool.
      const id = await createEmpty();
      const resaved = await app.inject({
        method: "PUT",
        url: `/api/agents/${id}`,
        payload: { runtime: { ...runtime(), ttlHours: 4 } },
      });
      expect(resaved.statusCode, resaved.body).toBe(200);
      const throughMcp = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}edit_agent`,
        { id, llmApiKeyId: null, modelId: null },
        {
          agent: { id, name: "Worker" },
          userId: ctx.user.id,
          organizationId: ctx.organizationId,
        },
      );
      expect(throughMcp.isError, JSON.stringify(throughMcp.content)).toBe(
        false,
      );

      // The default is no default here: the person has a connection to pick.
      expect((await read(id)).json()).toMatchObject({
        companyKey: false,
        companyAccount: NO_COMPANY_ACCOUNT,
      });
      const chooseConnection =
        "Choose a connection on the agent's page to run this agent.";
      expect(await preflight(id)).toMatchObject({
        ready: false,
        incompatible: null,
        accountError: chooseConnection,
        accountErrorFromChoice: false,
        accountErrorFromModel: false,
        accountErrorFromConnection: true,
      });
      const run = await app.inject({
        method: "POST",
        url: `/api/agents/${id}/runs`,
        payload: { message: "Start" },
      });
      expect(run.statusCode).toBe(409);
      expect(run.json().error.message).toBe(chooseConnection);

      const picked = await app.inject({
        method: "PUT",
        url: `/api/agents/${id}/runtime/account`,
        payload: {
          authentication: "provider",
          llmApiKeyId: fitting.key.id,
          modelId: fitting.model.id,
        },
      });
      expect(picked.statusCode, picked.body).toBe(200);
      expect(picked.json()).toMatchObject({
        companyKey: true,
        companyAccount: {
          connection: { id: fitting.key.id, fixedBy: null },
          model: { id: fitting.model.id, fixedBy: null },
          usesOrganizationDefault: false,
        },
      });
      expect(await preflight(id)).toMatchObject({
        ready: true,
        incompatible: null,
        accountError: null,
        accountErrorFromConnection: false,
      });
    });

    test("that the runtime can run is what an agent with nothing set runs on", async () => {
      await defaultTo(fitting);

      const id = await createEmpty();

      expect((await read(id)).json()).toMatchObject({
        companyKey: true,
        companyAccount: {
          connection: {
            id: fitting.key.id,
            name: fitting.key.name,
            provider: fits.provider,
            fixedBy: null,
          },
          model: { id: fitting.model.id, name: fits.modelId, fixedBy: null },
          usesOrganizationDefault: true,
        },
      });
      expect(await preflight(id)).toMatchObject({
        ready: true,
        incompatible: null,
        accountError: null,
        accountErrorFromConnection: false,
      });
    });
  });

  // An agent that sets no model, run on each person's own subscription, where
  // the organization's default is a model the runtime cannot run or the
  // subscription does not serve.
  describe.each([
    {
      runtimeName:
        "the maintained Codex runtime locked to each person's subscription",
      runtime: (): AgentRuntime =>
        runtimeFor({
          inferenceProtocol: "openai_responses",
          command: ["archestra-codex"],
          accountLock: "subscription",
        }),
      fits: { provider: "openai", modelId: "gpt-5.4" },
      unfit: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
      subscription: {
        kind: "chatgpt",
        apiKeyValue: "chatgpt-oauth:example-subscription",
      },
    },
    {
      runtimeName:
        "the maintained Codex runtime, where each person chooses and has not",
      runtime: (): AgentRuntime =>
        runtimeFor({
          inferenceProtocol: "openai_responses",
          command: ["archestra-codex"],
          accountLock: null,
        }),
      fits: { provider: "openai", modelId: "gpt-5.4" },
      unfit: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
      subscription: {
        kind: "chatgpt",
        apiKeyValue: "chatgpt-oauth:example-subscription",
      },
    },
  ] as const)("an organization default on $runtimeName", ({
    runtime,
    fits,
    unfit,
    subscription,
  }) => {
    let fitting: Awaited<ReturnType<typeof makeKeyWithModel>>;
    let other: Awaited<ReturnType<typeof makeKeyWithModel>>;

    beforeEach(async () => {
      await app.register(agentRoutes);
      fitting = await makeKeyWithModel({
        organizationId: ctx.organizationId,
        ...fits,
      });
      other = await makeKeyWithModel({
        organizationId: ctx.organizationId,
        ...unfit,
      });
    });

    const defaultTo = (set: typeof fitting) =>
      OrganizationModel.patch(ctx.organizationId, {
        defaultModelId: set.model.id,
        defaultLlmApiKeyId: set.key.id,
      });
    const preflight = async (agentId: string) =>
      (
        await app.inject({
          method: "GET",
          url: `/api/agents/${agentId}/runtime/preflight`,
        })
      ).json();

    test("that cannot run on it counts as none: the agent saves, and each person picks a model", async () => {
      await defaultTo(other);

      // Nothing was chosen, so nothing is refused: a new agent, an agent
      // whose builder empties both, a later change of the runtime alone, and
      // the MCP tool.
      const created = await app.inject({
        method: "POST",
        url: "/api/agents",
        payload: { agentType: "agent", name: "Worker", runtime: runtime() },
      });
      expect(created.statusCode, created.body).toBe(200);
      const id = created.json().id as string;
      const full = await app.inject({
        method: "POST",
        url: "/api/agents",
        payload: {
          agentType: "agent",
          name: "Worker with a model",
          runtime: runtime(),
          llmApiKeyId: fitting.key.id,
          modelId: fitting.model.id,
        },
      });
      expect(full.statusCode, full.body).toBe(200);
      const emptied = await app.inject({
        method: "PUT",
        url: `/api/agents/${full.json().id}`,
        payload: { runtime: runtime(), llmApiKeyId: null, modelId: null },
      });
      expect(emptied.statusCode, emptied.body).toBe(200);
      expect(emptied.json()).toMatchObject({
        llmApiKeyId: null,
        modelId: null,
      });
      const resaved = await app.inject({
        method: "PUT",
        url: `/api/agents/${id}`,
        payload: { runtime: { ...runtime(), ttlHours: 4 } },
      });
      expect(resaved.statusCode, resaved.body).toBe(200);
      const throughMcp = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}edit_agent`,
        { id, llmApiKeyId: null, modelId: null },
        {
          agent: { id, name: "Worker" },
          userId: ctx.user.id,
          organizationId: ctx.organizationId,
        },
      );
      expect(throughMcp.isError, JSON.stringify(throughMcp.content)).toBe(
        false,
      );

      // The default is no model here. The person signs in to their
      // subscription first: its models are what they pick from.
      const signedOut = await preflight(id);
      expect(signedOut).toMatchObject({
        ready: false,
        incompatible: null,
        accountErrorFromModel: false,
        missingSubscription: subscription.kind,
      });
      expect(signedOut.accountError).toMatch(/^Connect your own /);

      await makeKeyWithModel({
        organizationId: ctx.organizationId,
        provider: fits.provider,
        modelId: `${fits.modelId}-own`,
        userId: ctx.user.id,
        apiKeyValue: subscription.apiKeyValue,
      });
      expect(await preflight(id)).toMatchObject({
        ready: false,
        incompatible: null,
        accountError: "Choose a model on the agent's page to run this agent.",
        accountErrorFromChoice: false,
        accountErrorFromModel: true,
        accountErrorFromConnection: false,
        missingSubscription: null,
      });
    });

    test("that runs on it is what an agent with nothing set runs", async () => {
      await defaultTo(fitting);

      const created = await app.inject({
        method: "POST",
        url: "/api/agents",
        payload: { agentType: "agent", name: "Worker", runtime: runtime() },
      });
      expect(created.statusCode, created.body).toBe(200);

      // The model is not what holds the run back: the person has not signed
      // in to their subscription yet.
      const ready = await preflight(created.json().id);
      expect(ready).toMatchObject({
        incompatible: null,
        accountErrorFromModel: false,
        accountErrorFromConnection: false,
      });
      expect(ready.accountError).toMatch(/^Connect your own /);
    });
  });

  test("refuses a person without use on the agent", async ({
    makeAgent,
    makeCustomRole,
    makeMember,
    makeUser,
  }) => {
    const agent = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      runtime: runtimeFor({ inferenceProtocol: "openai_responses" }),
    });
    const reader = await makeUser();
    const role = await makeCustomRole(ctx.organizationId, { permission: {} });
    await makeMember(reader.id, ctx.organizationId, { role: role.role });
    const scope = {
      organizationId: ctx.organizationId,
      resource: "agent" as const,
      scope: agent.id,
    };
    const policy = await ResourcePermissionPolicyModel.find(scope);
    await ResourcePermissionPolicyModel.replace({
      ...scope,
      revision: policy?.revision ?? 0,
      grants: [{ subject: { type: "user", id: reader.id }, actions: ["read"] }],
    });
    ctx.user = reader;

    expect((await read(agent.id)).statusCode).toBe(403);
  });
});
