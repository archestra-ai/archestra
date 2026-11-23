import {
  resolveAgentRuntimeTiers,
  type SupportedProvider,
} from "@archestra/shared";
import { assert, vi } from "vitest";
import config from "@/config";
import {
  AgentModel,
  AgentRuntimeUserAccountModel,
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  OrganizationModel,
  UserCredentialModel,
  VirtualApiKeyModel,
} from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { makeKeyWithModel } from "@/routes/agent-runtime/agent-runtime-account.test-helpers";
import { claudeCodeAccountManager } from "@/services/agent-runtime/claude-code-account";
import { resolveAgentRunLimits } from "@/services/agent-runtime/runtime-tiers";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { Agent, ResolvedAgentRuntime, User } from "@/types";
import { assertAgentRuntimeModelCompatibility } from "./agent-config-validation";
import { buildAgentRunLaunchSpec } from "./launch-spec";
import {
  getResolvedAgentRuntimeModelCompatibility,
  preflightAgentRuntimeModelCompatibility,
} from "./model-compatibility";
import { canLaunchAgentRuntimeModel } from "./preflight";

const TIERS = resolveAgentRuntimeTiers(null, { defaultWarmSpares: 0 });

describe("a person's own account for their runs", () => {
  let organizationId: string;
  let author: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    config.llm.anthropic.vertexAi.enabled = false;
    vi.spyOn(config.agentRuntime, "platformBaseUrl", "get").mockReturnValue(
      "https://platform.example.test",
    );
    // The Kubernetes account adapter is the external storage boundary.
    vi.spyOn(claudeCodeAccountManager, "requireConnection").mockResolvedValue(
      undefined as never,
    );
    vi.spyOn(claudeCodeAccountManager, "status").mockResolvedValue({
      state: "connected",
    } as never);
    organizationId = (await makeOrganization()).id;
    author = await makeUser();
    await makeMember(author.id, organizationId, { role: "admin" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const agentWith = async (params: {
    makeAgent: (overrides: Record<string, unknown>) => Promise<Agent>;
    provider: SupportedProvider;
    modelId: string;
  }) => {
    const own = await makeKeyWithModel({
      organizationId,
      provider: params.provider,
      modelId: params.modelId,
    });
    const agent = await params.makeAgent({
      organizationId,
      authorId: author.id,
      agentType: "agent",
      llmApiKeyId: own.key.id,
      modelId: own.model.id,
    });
    return { agent, own };
  };

  const member = async (
    makeUser: () => Promise<User>,
    makeMember: (
      userId: string,
      organizationId: string,
      overrides: { role: string },
    ) => Promise<unknown>,
  ) => {
    const user = await makeUser();
    await makeMember(user.id, organizationId, { role: "member" });
    return user;
  };

  const launch = (params: {
    agent: Agent;
    runtime: ResolvedAgentRuntime;
    actor: { kind: "user" | "serviceAccount"; id: string };
  }) =>
    buildAgentRunLaunchSpec({
      runtime: params.runtime,
      limits: resolveAgentRunLimits({ runtime: params.runtime, tiers: TIERS }),
      taskId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      agentId: params.agent.id,
      actor: { ...params.actor, organizationId },
      organizationId,
      runtimeScope: "agent-tests",
      effectiveNetworkPolicy: { source: "built_in", policy: null },
      appName: "Archestra",
      runMode: "one_shot",
    });

  const boundKeyId = async (virtualApiKeyId: string | null | undefined) => {
    assert(virtualApiKeyId);
    const mapped = await VirtualApiKeyModel.getProviderApiKeys(virtualApiKeyId);
    return mapped.map((entry) => entry.providerApiKeyId);
  };

  const chooseCompanyKey = (agent: Agent, userId: string) =>
    AgentRuntimeUserAccountModel.upsert({
      agentId: agent.id,
      userId,
      authentication: "provider",
      modelId: null,
    });

  const chooseSubscription = (
    agent: Agent,
    userId: string,
    modelId: string | null = null,
  ) =>
    AgentRuntimeUserAccountModel.upsert({
      agentId: agent.id,
      userId,
      authentication: "subscription",
      modelId,
    });

  test("a company-key choice binds the agent's own key and model", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const { agent, own } = await agentWith({
      makeAgent,
      provider: "openai",
      modelId: "gpt-5.4",
    });
    const chooser = await member(makeUser, makeMember);
    // Another company key the person could once have picked: never bound.
    await makeKeyWithModel({
      organizationId,
      provider: "openai",
      modelId: "gpt-5.4-mini",
    });
    await chooseCompanyKey(agent, chooser.id);
    const runtime = genericRuntime(agent, "openai_chat");

    const resolved = await preflightAgentRuntimeModelCompatibility({
      runtime,
      agent,
      agentId: agent.id,
      organizationId,
      userId: chooser.id,
    });
    const run = await launch({
      agent,
      runtime,
      actor: { kind: "user", id: chooser.id },
    });

    expect(resolved.account).toEqual({
      source: "choice",
      authentication: "provider",
      keyId: own.key.id,
    });
    expect(resolved.llm).toMatchObject({
      modelId: own.model.id,
      chatApiKeyId: own.key.id,
      selectedModel: "gpt-5.4",
    });
    expect(await boundKeyId(run.virtualApiKeyId)).toEqual([own.key.id]);
    expect(run.spec.env.ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL).toBe("gpt-5.4");
  });

  test("a company-key choice binds the agent's key for a person the key is not shared with", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const { agent, own } = await agentWith({
      makeAgent,
      provider: "openai",
      modelId: "gpt-5.4",
    });
    const chooser = await member(makeUser, makeMember);
    await chooseCompanyKey(agent, chooser.id);
    const scope = {
      organizationId,
      resource: "llmProviderApiKey" as const,
      scope: own.key.id,
    };
    const policy = await ResourcePermissionPolicyModel.find(scope);
    await ResourcePermissionPolicyModel.replace({
      ...scope,
      revision: policy?.revision ?? 0,
      grants: [],
    });

    // It is the agent's key, not one the person picked: their own access to
    // it is not what decides.
    const run = await launch({
      agent,
      runtime: genericRuntime(agent, "openai_chat"),
      actor: { kind: "user", id: chooser.id },
    });

    expect(await boundKeyId(run.virtualApiKeyId)).toEqual([own.key.id]);
  });

  test("a run that is not a person's uses the agent's own account", async ({
    makeAgent,
    makeServiceAccount,
  }) => {
    const { agent, own } = await agentWith({
      makeAgent,
      provider: "xai",
      modelId: "grok-4.3",
    });
    // The author's own runs now need their SuperGrok subscription.
    await chooseSubscription(agent, author.id);
    const runtime = grokRuntime(agent);
    await expect(
      launch({ agent, runtime, actor: { kind: "user", id: author.id } }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message:
        "Connect your own SuperGrok before starting this Agent, or choose a company API key as your account.",
    });

    const run = await launch({
      agent,
      runtime,
      actor: {
        kind: "serviceAccount",
        id: (await makeServiceAccount(organizationId)).id,
      },
    });

    expect(await boundKeyId(run.virtualApiKeyId)).toEqual([own.key.id]);
  });

  test("one person's choice leaves another person's runs on the agent's account", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const { agent, own } = await agentWith({
      makeAgent,
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
    const chooser = await member(makeUser, makeMember);
    const other = await member(makeUser, makeMember);
    await chooseSubscription(agent, chooser.id);
    const runtime = claudeCodeRuntime(agent, "provider");

    const mine = await launch({
      agent,
      runtime,
      actor: { kind: "user", id: chooser.id },
    });
    const theirs = await launch({
      agent,
      runtime,
      actor: { kind: "user", id: other.id },
    });

    assert(mine.virtualApiKeyId);
    expect(
      await VirtualApiKeyModel.findById(mine.virtualApiKeyId),
    ).toMatchObject({ keyType: "passthrough" });
    expect(await boundKeyId(theirs.virtualApiKeyId)).toEqual([own.key.id]);
  });

  test("a later turn uses the account chosen since", async ({ makeAgent }) => {
    const { agent, own } = await agentWith({
      makeAgent,
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
    const runtime = claudeCodeRuntime(agent, "subscription");
    const actor = { kind: "user" as const, id: author.id };

    const first = await launch({ agent, runtime, actor });
    await chooseCompanyKey(agent, author.id);
    const second = await launch({ agent, runtime, actor });

    assert(first.virtualApiKeyId);
    expect(
      await VirtualApiKeyModel.findById(first.virtualApiKeyId),
    ).toMatchObject({ keyType: "passthrough" });
    expect(await boundKeyId(second.virtualApiKeyId)).toEqual([own.key.id]);
  });

  describe("on a runtime that can run Claude", () => {
    test("a person's subscription runs the Claude model they picked, others the agent's", async ({
      makeAgent,
      makeUser,
      makeMember,
    }) => {
      const { agent } = await agentWith({
        makeAgent,
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
      });
      const chooser = await member(makeUser, makeMember);
      await AgentRuntimeUserAccountModel.upsert({
        agentId: agent.id,
        userId: chooser.id,
        authentication: "subscription",
        modelId: null,
        claudeModel: "sonnet",
      });
      const runtime = {
        ...claudeCodeRuntime(agent, "subscription"),
        claudeCode: { authentication: "subscription" as const, model: "haiku" },
      };

      const theirs = await launch({
        agent,
        runtime,
        actor: { kind: "user", id: chooser.id },
      });
      const others = await launch({
        agent,
        runtime,
        actor: { kind: "user", id: author.id },
      });

      expect(theirs.spec.env.ARCHESTRA_AGENT_RUNTIME_MODEL).toBe("sonnet");
      expect(others.spec.env.ARCHESTRA_AGENT_RUNTIME_MODEL).toBe("haiku");
    });

    for (const agentAuthentication of ["provider", "subscription"] as const) {
      test(`a person's subscription wins over an agent set to ${agentAuthentication}`, async ({
        makeAgent,
      }) => {
        const { agent } = await agentWith({
          makeAgent,
          provider: "anthropic",
          modelId: "claude-sonnet-4-6",
        });
        await chooseSubscription(agent, author.id);

        const run = await launch({
          agent,
          runtime: claudeCodeRuntime(agent, agentAuthentication),
          actor: { kind: "user", id: author.id },
        });

        assert(run.virtualApiKeyId);
        expect(
          await VirtualApiKeyModel.findById(run.virtualApiKeyId),
        ).toMatchObject({ keyType: "passthrough" });
        expect(claudeCodeAccountManager.requireConnection).toHaveBeenCalled();
      });

      test(`a person's company-key choice runs the agent's own key and model on an agent set to ${agentAuthentication}`, async ({
        makeAgent,
      }) => {
        const { agent, own } = await agentWith({
          makeAgent,
          provider: "anthropic",
          modelId: "claude-sonnet-4-6",
        });
        // Another company key and model in the organization: never bound.
        await makeKeyWithModel({
          organizationId,
          provider: "anthropic",
          modelId: "claude-opus-4-6",
        });
        await chooseCompanyKey(agent, author.id);

        const run = await launch({
          agent,
          runtime: claudeCodeRuntime(agent, agentAuthentication),
          actor: { kind: "user", id: author.id },
        });

        expect(await boundKeyId(run.virtualApiKeyId)).toEqual([own.key.id]);
        expect(run.spec.env.ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL).toBe(
          "claude-sonnet-4-6",
        );
        expect(run.spec.secretEnv).not.toHaveProperty(
          "CLAUDE_CODE_OAUTH_TOKEN",
        );
        expect(
          claudeCodeAccountManager.requireConnection,
        ).not.toHaveBeenCalled();
      });
    }

    test("a person's subscription wins over an agent on Bedrock", async ({
      makeAgent,
    }) => {
      const { agent } = await agentWith({
        makeAgent,
        provider: "bedrock",
        modelId: "us.anthropic.claude-sonnet-4-6",
      });
      await chooseSubscription(agent, author.id);

      const run = await launch({
        agent,
        runtime: claudeCodeRuntime(agent, "provider"),
        actor: { kind: "user", id: author.id },
      });

      expect(run.spec.env).not.toHaveProperty("CLAUDE_CODE_USE_BEDROCK");
      assert(run.virtualApiKeyId);
      expect(
        await VirtualApiKeyModel.findById(run.virtualApiKeyId),
      ).toMatchObject({ keyType: "passthrough" });
    });
  });

  describe("a declared Claude subscription token", () => {
    const pasteToken = (agent: Agent) =>
      UserCredentialModel.upsert({
        organizationId,
        userId: author.id,
        agentId: agent.id,
        key: "CLAUDE_CODE_OAUTH_TOKEN",
        value: "pasted-subscription-token",
      });
    const withToken = (
      runtime: ResolvedAgentRuntime,
    ): ResolvedAgentRuntime => ({
      ...runtime,
      credentials: [
        {
          key: "CLAUDE_CODE_OAUTH_TOKEN",
          scope: "per_user",
          label: "Claude Code subscription token",
          required: false,
        },
      ],
    });

    test("is set aside on the maintained Claude Code runtime on company billing", async ({
      makeAgent,
    }) => {
      const { agent, own } = await agentWith({
        makeAgent,
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
      });
      await pasteToken(agent);

      const run = await launch({
        agent,
        runtime: withToken(claudeCodeRuntime(agent, "provider")),
        actor: { kind: "user", id: author.id },
      });

      expect(await boundKeyId(run.virtualApiKeyId)).toEqual([own.key.id]);
      expect(run.spec.secretEnv).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    });

    test("is set aside when a person runs a company-billed custom image on their subscription", async ({
      makeAgent,
    }) => {
      const { agent } = await agentWith({
        makeAgent,
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
      });
      await chooseSubscription(agent, author.id);
      await pasteToken(agent);
      const runtime = withToken({
        ...genericRuntime(agent, "anthropic"),
        command: ["custom-agent"],
        claudeCode: { authentication: "provider" },
      });

      const run = await launch({
        agent,
        runtime,
        actor: { kind: "user", id: author.id },
      });

      assert(run.virtualApiKeyId);
      expect(
        await VirtualApiKeyModel.findById(run.virtualApiKeyId),
      ).toMatchObject({ keyType: "passthrough" });
      expect(run.spec.secretEnv.CLAUDE_CODE_OAUTH_TOKEN).toMatch(/^arch_/);
      expect(JSON.stringify(run.spec)).not.toContain(
        "pasted-subscription-token",
      );
    });
  });

  describe("on the maintained Codex runtime", () => {
    test("a person's company-key choice needs no ChatGPT subscription", async ({
      makeAgent,
    }) => {
      const { agent, own } = await agentWith({
        makeAgent,
        provider: "openai",
        modelId: "gpt-5.4",
      });
      const runtime = codexRuntime(agent);
      const actor = { kind: "user" as const, id: author.id };
      // Without the choice, the maintained runtime needs their ChatGPT.
      await expect(launch({ agent, runtime, actor })).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining("Connect your own ChatGPT"),
      });
      await chooseCompanyKey(agent, author.id);

      const run = await launch({ agent, runtime, actor });

      expect(await boundKeyId(run.virtualApiKeyId)).toEqual([own.key.id]);
    });

    test("a person's subscription choice still needs their ChatGPT subscription", async ({
      makeAgent,
    }) => {
      const { agent } = await agentWith({
        makeAgent,
        provider: "openai",
        modelId: "gpt-5.4",
      });
      await chooseSubscription(agent, author.id);

      await expect(
        launch({
          agent,
          runtime: codexRuntime(agent),
          actor: { kind: "user", id: author.id },
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining("Connect your own ChatGPT"),
      });
    });
  });

  describe("on the maintained Grok Build runtime", () => {
    test("a person's SuperGrok row binds their own SuperGrok key, not the agent's", async ({
      makeAgent,
    }) => {
      const { agent, own } = await agentWith({
        makeAgent,
        provider: "xai",
        modelId: "grok-4.3",
      });
      const superGrok = await makeKeyWithModel({
        organizationId,
        provider: "xai",
        modelId: "grok-4.3-own",
        userId: author.id,
        apiKeyValue: "xai-subscription:example-subscription",
      });
      await chooseSubscription(agent, author.id, superGrok.model.id);

      const run = await launch({
        agent,
        runtime: grokRuntime(agent),
        actor: { kind: "user", id: author.id },
      });

      const bound = await boundKeyId(run.virtualApiKeyId);
      expect(bound).toEqual([superGrok.key.id]);
      expect(bound).not.toContain(own.key.id);
    });

    test("a person's SuperGrok row without a model is refused on an agent whose model is another provider's", async ({
      makeAgent,
      makeUser,
      makeMember,
    }) => {
      const { agent, own } = await agentWith({
        makeAgent,
        provider: "openai",
        modelId: "gpt-4.1",
      });
      await makeKeyWithModel({
        organizationId,
        provider: "xai",
        modelId: "grok-4.3",
        userId: author.id,
        apiKeyValue: "xai-subscription:example-subscription",
      });
      await chooseSubscription(agent, author.id);

      await expect(
        launch({
          agent,
          runtime: grokRuntime(agent),
          actor: { kind: "user", id: author.id },
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message:
          "This agent's model is not available through your SuperGrok. Choose a model on the agent's page.",
      });

      // Someone who chose nothing still runs the agent's own model and key.
      const colleague = await member(makeUser, makeMember);
      const run = await launch({
        agent,
        runtime: grokRuntime(agent),
        actor: { kind: "user", id: colleague.id },
      });
      expect(await boundKeyId(run.virtualApiKeyId)).toEqual([own.key.id]);
    });
  });

  describe("the company API key an agent leaves to each person", () => {
    /** The organization's default, shared with everyone. */
    const organizationDefault = async () => {
      const set = await makeKeyWithModel({
        organizationId,
        provider: "openai",
        modelId: "gpt-5.4",
      });
      await OrganizationModel.patch(organizationId, {
        defaultModelId: set.model.id,
        defaultLlmApiKeyId: set.key.id,
      });
      return set;
    };
    const choose = (
      agent: Agent,
      userId: string,
      parts: { llmApiKeyId?: string; modelId?: string },
    ) =>
      AgentRuntimeUserAccountModel.upsert({
        agentId: agent.id,
        userId,
        authentication: "provider",
        llmApiKeyId: parts.llmApiKeyId ?? null,
        modelId: parts.modelId ?? null,
      });
    const ranOn = async (
      agent: Agent,
      actor: { kind: "user" | "serviceAccount"; id: string },
    ) => {
      const run = await launch({
        agent,
        runtime: genericRuntime(agent, "openai_chat"),
        actor,
      });
      return {
        boundKeyIds: await boundKeyId(run.virtualApiKeyId),
        model: run.spec.env.ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL,
      };
    };

    test("with nothing set, runs use the organization's default, and a person's own connection and model once they pick them", async ({
      makeAgent,
      makeUser,
      makeMember,
      makeServiceAccount,
    }) => {
      const byDefault = await organizationDefault();
      const picked = await makeKeyWithModel({
        organizationId,
        provider: "openai",
        modelId: "gpt-5.4-mini",
      });
      const agent = await makeAgent({
        organizationId,
        authorId: author.id,
        agentType: "agent",
      });
      const chooser = await member(makeUser, makeMember);
      const other = await member(makeUser, makeMember);
      const onTheDefault = {
        boundKeyIds: [byDefault.key.id],
        model: "gpt-5.4",
      };
      expect(await ranOn(agent, { kind: "user", id: chooser.id })).toEqual(
        onTheDefault,
      );

      await choose(agent, chooser.id, {
        llmApiKeyId: picked.key.id,
        modelId: picked.model.id,
      });

      expect(await ranOn(agent, { kind: "user", id: chooser.id })).toEqual({
        boundKeyIds: [picked.key.id],
        model: "gpt-5.4-mini",
      });
      // Nobody else's runs follow it.
      expect(await ranOn(agent, { kind: "user", id: other.id })).toEqual(
        onTheDefault,
      );
      // A run with no person has no choice, and reaches no default either,
      // as before: it is refused until the agent sets a connection, and
      // told who can set one, since it has no page to pick on.
      await expect(
        ranOn(agent, {
          kind: "serviceAccount",
          id: (await makeServiceAccount(organizationId)).id,
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message:
          "This agent leaves its connection to each person, and this run has no person behind it. Someone who can edit the agent must set a connection.",
      });
      expect(await AgentModel.findById(agent.id)).toMatchObject({
        llmApiKeyId: null,
        modelId: null,
      });
    });

    test.for([
      null,
      "key",
    ] as const)("with the connection set and no model, under %s lock, every person runs on it with the model they pick", async (accountLock, {
      makeAgent,
      makeUser,
      makeMember,
      makeServiceAccount,
    }) => {
      // The organization's default is another connection's: never used here.
      await organizationDefault();
      // Only administrators reach the connection the builder set.
      const set = await makeKeyWithModel({
        organizationId,
        provider: "openai",
        modelId: "gpt-5.4-mini",
        adminsOnly: true,
      });
      const second = await makeKeyWithModel({
        organizationId,
        provider: "openai",
        modelId: "gpt-5.4-nano",
        adminsOnly: true,
      });
      await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(set.key.id, [
        set.model.id,
        second.model.id,
      ]);
      const agent = await makeAgent({
        organizationId,
        authorId: author.id,
        agentType: "agent",
        llmApiKeyId: set.key.id,
      });
      const runtime = { ...genericRuntime(agent, "openai_chat"), accountLock };
      const chooser = await member(makeUser, makeMember);
      const other = await member(makeUser, makeMember);
      const runOf = async (actor: {
        kind: "user" | "serviceAccount";
        id: string;
      }) => {
        const run = await launch({ agent, runtime, actor });
        return {
          boundKeyIds: await boundKeyId(run.virtualApiKeyId),
          model: run.spec.env.ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL,
        };
      };
      const needsModel = {
        statusCode: 409,
        message: "Choose a model on the agent's page to run this agent.",
      };
      await expect(
        runOf({ kind: "user", id: chooser.id }),
      ).rejects.toMatchObject(needsModel);

      await choose(agent, chooser.id, { modelId: second.model.id });
      await choose(agent, other.id, { modelId: set.model.id });

      expect(await runOf({ kind: "user", id: chooser.id })).toEqual({
        boundKeyIds: [set.key.id],
        model: "gpt-5.4-nano",
      });
      expect(await runOf({ kind: "user", id: other.id })).toEqual({
        boundKeyIds: [set.key.id],
        model: "gpt-5.4-mini",
      });
      // With no person there is nobody to pick a model: the run is told who
      // can set one.
      await expect(
        runOf({
          kind: "serviceAccount",
          id: (await makeServiceAccount(organizationId)).id,
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message:
          "This agent leaves its model to each person, and this run has no person behind it. Someone who can edit the agent must set a model.",
      });
    });

    test("with the connection set and no model, the organization's default model runs where the connection serves it", async ({
      makeAgent,
      makeServiceAccount,
    }) => {
      const byDefault = await organizationDefault();
      const set = await makeKeyWithModel({
        organizationId,
        provider: "openai",
        modelId: "gpt-5.4-mini",
      });
      await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(set.key.id, [
        set.model.id,
        byDefault.model.id,
      ]);
      const agent = await makeAgent({
        organizationId,
        authorId: author.id,
        agentType: "agent",
        llmApiKeyId: set.key.id,
      });

      // The default's model, on the agent's connection, for people and for
      // a run with no person alike.
      for (const actor of [
        { kind: "user" as const, id: author.id },
        {
          kind: "serviceAccount" as const,
          id: (await makeServiceAccount(organizationId)).id,
        },
      ]) {
        expect(await ranOn(agent, actor)).toEqual({
          boundKeyIds: [set.key.id],
          model: "gpt-5.4",
        });
      }
    });

    test("a part the agent sets since is what runs, whatever the person picked before", async ({
      makeAgent,
      makeUser,
      makeMember,
    }) => {
      const picked = await makeKeyWithModel({
        organizationId,
        provider: "openai",
        modelId: "gpt-5.4-mini",
      });
      const set = await makeKeyWithModel({
        organizationId,
        provider: "openai",
        modelId: "gpt-5.4",
      });
      const agent = await makeAgent({
        organizationId,
        authorId: author.id,
        agentType: "agent",
      });
      const chooser = await member(makeUser, makeMember);
      await choose(agent, chooser.id, {
        llmApiKeyId: picked.key.id,
        modelId: picked.model.id,
      });

      // The agent sets the connection alone: the person's pick for another
      // connection is set aside, and its model is no model of this one, so
      // they have a model to pick. Nothing of theirs is broken.
      await AgentModel.update(agent.id, { llmApiKeyId: set.key.id });
      const withConnection = await AgentModel.findById(agent.id);
      assert(withConnection);
      await expect(
        ranOn(withConnection, { kind: "user", id: chooser.id }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: "Choose a model on the agent's page to run this agent.",
      });
      expect(
        await getResolvedAgentRuntimeModelCompatibility({
          runtime: genericRuntime(withConnection, "openai_chat"),
          agent: withConnection,
          agentId: agent.id,
          organizationId,
          userId: chooser.id,
        }),
      ).toMatchObject({
        accountErrorFromChoice: false,
        accountErrorFromModel: true,
      });

      // The connection they picked is deleted, and its model with it. Both
      // were set aside already, so nothing of theirs broke either.
      await LlmProviderApiKeyModel.delete(picked.key.id);
      await ModelModel.deleteOrphanedModels();
      expect(
        await AgentRuntimeUserAccountModel.find({
          agentId: agent.id,
          userId: chooser.id,
        }),
      ).toMatchObject({ llmApiKeyId: null, modelId: null });
      await expect(
        ranOn(withConnection, { kind: "user", id: chooser.id }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: "Choose a model on the agent's page to run this agent.",
      });

      // The agent sets the model too: nothing is left to ask.
      await AgentModel.update(agent.id, { modelId: set.model.id });
      const updated = await AgentModel.findById(agent.id);
      assert(updated);

      expect(await ranOn(updated, { kind: "user", id: chooser.id })).toEqual({
        boundKeyIds: [set.key.id],
        model: "gpt-5.4",
      });
    });

    test("an organization default the runtime cannot run counts as none: no run starts on it, and the person's pick is what runs", async ({
      makeAgent,
      makeUser,
      makeMember,
    }) => {
      // The default is another provider's than the maintained Codex runtime
      // runs, and both connections are the person's to use.
      const anthropic = await makeKeyWithModel({
        organizationId,
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
      });
      await OrganizationModel.patch(organizationId, {
        defaultModelId: anthropic.model.id,
        defaultLlmApiKeyId: anthropic.key.id,
      });
      const openai = await makeKeyWithModel({
        organizationId,
        provider: "openai",
        modelId: "gpt-5.4",
      });
      const agent = await makeAgent({
        organizationId,
        authorId: author.id,
        agentType: "agent",
      });
      const runtime = { ...codexRuntime(agent), accountLock: "key" as const };
      const person = await member(makeUser, makeMember);
      const actor = { kind: "user" as const, id: person.id };

      await expect(launch({ agent, runtime, actor })).rejects.toMatchObject({
        statusCode: 409,
        message: "Choose a connection on the agent's page to run this agent.",
      });
      expect(
        await canLaunchAgentRuntimeModel({
          runtime,
          agent,
          actor: { ...actor, organizationId },
        }),
      ).toBe(false);

      await choose(agent, person.id, {
        llmApiKeyId: openai.key.id,
        modelId: openai.model.id,
      });
      const run = await launch({ agent, runtime, actor });
      expect(await boundKeyId(run.virtualApiKeyId)).toEqual([openai.key.id]);
      expect(run.spec.env.ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL).toBe("gpt-5.4");
    });

    test("with no connection set, chosen or given by the organization's default, the run asks for one", async ({
      makeAgent,
      makeUser,
      makeMember,
    }) => {
      // The only connection is one the person may not use.
      await makeKeyWithModel({
        organizationId,
        provider: "openai",
        modelId: "gpt-5.4",
        adminsOnly: true,
      });
      const agent = await makeAgent({
        organizationId,
        authorId: author.id,
        agentType: "agent",
      });
      const person = await member(makeUser, makeMember);

      await expect(
        ranOn(agent, { kind: "user", id: person.id }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: "Choose a connection on the agent's page to run this agent.",
      });
    });
  });

  describe("a choice that no longer works", () => {
    const BROKEN_COMPANY_KEY =
      "Your own account for this agent no longer works. The agent's own API key or model is missing or no longer linked. Choose your account again.";

    test("refuses the run when the agent's key belongs to another organization", async ({
      makeAgent,
      makeOrganization,
    }) => {
      const foreign = await makeKeyWithModel({
        organizationId: (await makeOrganization()).id,
        provider: "openai",
        modelId: "gpt-5.4-foreign",
      });
      const agent = await makeAgent({
        organizationId,
        authorId: author.id,
        agentType: "agent",
        llmApiKeyId: foreign.key.id,
        modelId: foreign.model.id,
      });
      await chooseCompanyKey(agent, author.id);

      await expect(
        launch({
          agent,
          runtime: genericRuntime(agent, "openai_chat"),
          actor: { kind: "user", id: author.id },
        }),
      ).rejects.toMatchObject({ statusCode: 409, message: BROKEN_COMPANY_KEY });
    });

    test("refuses the run when the agent's key is a personal subscription", async ({
      makeAgent,
    }) => {
      const personal = await makeKeyWithModel({
        organizationId,
        provider: "openai",
        modelId: "gpt-5.4-personal",
        userId: author.id,
        apiKeyValue: "chatgpt-oauth:example-subscription",
      });
      const agent = await makeAgent({
        organizationId,
        authorId: author.id,
        agentType: "agent",
        llmApiKeyId: personal.key.id,
        modelId: personal.model.id,
      });
      // Stored directly: PUT refuses this choice, a run must refuse it too.
      await chooseCompanyKey(agent, author.id);

      await expect(
        launch({
          agent,
          runtime: genericRuntime(agent, "openai_chat"),
          actor: { kind: "user", id: author.id },
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message:
          "Your own account for this agent no longer works. The agent's own key is a personal subscription, not a company API key. Choose your account again.",
      });
    });

    test("refuses the run when the agent's key no longer serves its model", async ({
      makeAgent,
    }) => {
      const { agent, own } = await agentWith({
        makeAgent,
        provider: "openai",
        modelId: "gpt-5.4",
      });
      const other = await makeKeyWithModel({
        organizationId,
        provider: "openai",
        modelId: "gpt-5.4-mini",
      });
      await chooseCompanyKey(agent, author.id);
      await AgentModel.update(agent.id, {
        llmApiKeyId: own.key.id,
        modelId: other.model.id,
      });

      await expect(
        launch({
          agent,
          runtime: genericRuntime(agent, "openai_chat"),
          actor: { kind: "user", id: author.id },
        }),
      ).rejects.toMatchObject({ statusCode: 409, message: BROKEN_COMPANY_KEY });
    });

    test("once the agent's model was removed, the run waits for the person to pick one of its connection's", async ({
      makeAgent,
    }) => {
      const { agent } = await agentWith({
        makeAgent,
        provider: "openai",
        modelId: "gpt-5.4-nano",
      });
      // The organization default an agent without the choice would run on.
      await makeKeyWithModel({
        organizationId,
        provider: "openai",
        modelId: "gpt-5.4",
      });
      await chooseCompanyKey(agent, author.id);
      await ModelModel.delete("openai", "gpt-5.4-nano");

      // The agent's connection still holds for everyone: never the default.
      await expect(
        launch({
          agent,
          runtime: genericRuntime(agent, "openai_chat"),
          actor: { kind: "user", id: author.id },
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: "Choose a model on the agent's page to run this agent.",
      });
    });

    test("once the agent's key is deleted, its connection is each person's to choose, and the default until they do", async ({
      makeAgent,
    }) => {
      const { agent, own } = await agentWith({
        makeAgent,
        provider: "openai",
        modelId: "gpt-5.4",
      });
      // Another company key that serves the model.
      const fallback = await makeKeyWithModel({
        organizationId,
        provider: "openai",
        modelId: "gpt-5.4",
      });
      await chooseCompanyKey(agent, author.id);
      await LlmProviderApiKeyModel.delete(own.key.id);

      // The person chose the company API key, and no connection of their own.
      const run = await launch({
        agent,
        runtime: genericRuntime(agent, "openai_chat"),
        actor: { kind: "user", id: author.id },
      });

      expect(await boundKeyId(run.virtualApiKeyId)).toEqual([fallback.key.id]);
    });

    test("refuses the run when the chosen model cannot run on a personal subscription", async ({
      makeAgent,
    }) => {
      const { agent } = await agentWith({
        makeAgent,
        provider: "xai",
        modelId: "grok-4.3",
      });
      const local = await makeKeyWithModel({
        organizationId,
        provider: "vllm",
        modelId: "local-small",
      });
      // Stored directly: PUT refuses this choice, a run must refuse it too.
      await chooseSubscription(agent, author.id, local.model.id);

      await expect(
        launch({
          agent,
          runtime: grokRuntime(agent),
          actor: { kind: "user", id: author.id },
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message:
          "Your own account for this agent no longer works. local-small cannot run on a personal subscription here. Choose your account again.",
      });
    });

    test("judges a load-balanced candidate with the caller's choice", async ({
      makeAgent,
    }) => {
      const { agent } = await agentWith({
        makeAgent,
        provider: "xai",
        modelId: "grok-4.3",
      });
      const runtime = grokRuntime(agent);
      const actor = { kind: "user" as const, id: author.id, organizationId };
      expect(await canLaunchAgentRuntimeModel({ runtime, agent, actor })).toBe(
        true,
      );
      // Their own runs now need a SuperGrok subscription they have not connected.
      await chooseSubscription(agent, author.id);

      expect(await canLaunchAgentRuntimeModel({ runtime, agent, actor })).toBe(
        false,
      );
    });

    test("does not hold up saving the agent itself", async ({ makeAgent }) => {
      const { agent } = await agentWith({
        makeAgent,
        provider: "openai",
        modelId: "gpt-5.4",
      });
      const personal = await makeKeyWithModel({
        organizationId,
        provider: "openai",
        modelId: "gpt-5.4-personal",
        userId: author.id,
        apiKeyValue: "chatgpt-oauth:example-subscription",
      });
      await chooseCompanyKey(agent, author.id);
      // The agent's key is now someone's subscription: the choice is stale.
      await AgentModel.update(agent.id, {
        llmApiKeyId: personal.key.id,
        modelId: personal.model.id,
      });
      const stored = await AgentModel.findById(agent.id);
      assert(stored);
      const runtime = genericRuntime(agent, "openai_chat");
      await expect(
        preflightAgentRuntimeModelCompatibility({
          runtime,
          agent: stored,
          agentId: agent.id,
          organizationId,
          userId: author.id,
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining("Choose your account again"),
      });

      await expect(
        assertAgentRuntimeModelCompatibility({
          runtime,
          agent: stored,
          organizationId,
          userId: author.id,
          selectsModel: false,
        }),
      ).resolves.toBeUndefined();
    });
  });
});

function genericRuntime(
  agent: Agent,
  inferenceProtocol: ResolvedAgentRuntime["inferenceProtocol"],
): ResolvedAgentRuntime {
  return {
    agentId: agent.id,
    accountLock: null,
    organizationId: agent.organizationId,
    environmentId: null,
    secretId: null,
    image: "agent-image:dev",
    command: null,
    inferenceProtocol,
    backend: "kubernetes",
    steerMode: "pipe",
    privileged: false,
    environment: null,
    credentials: null,
    ttlHours: null,
    maxCostUsd: null,
    idleTimeoutMinutes: null,
  };
}

function claudeCodeRuntime(
  agent: Agent,
  authentication: "provider" | "subscription",
): ResolvedAgentRuntime {
  return {
    ...genericRuntime(agent, "anthropic"),
    command: ["archestra-claude-code"],
    claudeCode: { authentication },
  };
}

function codexRuntime(agent: Agent): ResolvedAgentRuntime {
  return {
    ...genericRuntime(agent, "openai_responses"),
    command: ["archestra-codex"],
  };
}

function grokRuntime(agent: Agent): ResolvedAgentRuntime {
  return {
    ...genericRuntime(agent, "openai_chat"),
    command: ["archestra-grok"],
  };
}
