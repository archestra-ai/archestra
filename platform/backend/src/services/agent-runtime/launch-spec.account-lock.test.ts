import {
  DEFAULT_CLAUDE_CODE_MODEL,
  type SupportedProvider,
} from "@archestra/shared";
import { assert, vi } from "vitest";
import type { A2AActor } from "@/agents/a2a/a2a-base";
import config from "@/config";
import {
  AgentModel,
  AgentRuntimeUserAccountModel,
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  VirtualApiKeyModel,
} from "@/models";
import { makeKeyWithModel } from "@/routes/agent-runtime/agent-runtime-account.test-helpers";
import { claudeCodeAccountManager } from "@/services/agent-runtime/claude-code-account";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  type Agent,
  type AgentRuntimeAccountLock,
  OWN_ACCOUNT_ONLY,
  type ResolvedAgentRuntime,
  type User,
} from "@/types";
import { assertRunHonoursAccountLock } from "./account-resolution";
import { kubernetesAgentRuntimeBackendDriver } from "./backends/kubernetes";
import { buildAgentRunLaunchSpec } from "./launch-spec";
import {
  getResolvedAgentRuntimeModelCompatibility,
  preflightAgentRuntimeModelCompatibility,
} from "./model-compatibility";
import { bindRunProviderKey, preflightAgentRuntimeLaunch } from "./preflight";

const KEY_LOCK_BROKEN_PAIR =
  "This agent is locked to a company API key, but its own API key no longer serves its model.";
const CHOOSE_MODEL = "Choose a model on the agent's page to run this agent.";

describe("an agent's account lock at run time", () => {
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
    // So is the cluster a run's setup check finds ready.
    vi.spyOn(
      kubernetesAgentRuntimeBackendDriver,
      "assertReady",
    ).mockResolvedValue();
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

  const launch = (params: {
    agent: Agent;
    runtime: ResolvedAgentRuntime;
    actor?: A2AActor;
  }) =>
    buildAgentRunLaunchSpec({
      runtime: params.runtime,
      taskId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      agentId: params.agent.id,
      actor: params.actor ?? { kind: "user", id: author.id, organizationId },
      organizationId,
      runtimeScope: "agent-tests",
      effectiveNetworkPolicy: { source: "built_in", policy: null },
      appName: "Archestra",
      runMode: "one_shot",
    });

  const ready = (params: { agent: Agent; runtime: ResolvedAgentRuntime }) =>
    preflightAgentRuntimeLaunch({
      ...params,
      actor: { kind: "user", id: author.id, organizationId },
    });

  const boundKeyId = async (virtualApiKeyId: string | null | undefined) => {
    assert(virtualApiKeyId);
    const mapped = await VirtualApiKeyModel.getProviderApiKeys(virtualApiKeyId);
    return mapped.map((entry) => entry.providerApiKeyId);
  };

  const isPassthrough = async (virtualApiKeyId: string | null | undefined) => {
    assert(virtualApiKeyId);
    return (
      (await VirtualApiKeyModel.findById(virtualApiKeyId))?.keyType ===
      "passthrough"
    );
  };

  const choose = async (
    agent: Agent,
    authentication: "subscription" | "provider",
  ) =>
    AgentRuntimeUserAccountModel.upsert({
      agentId: agent.id,
      userId: author.id,
      authentication,
      modelId: null,
    });

  describe("on a runtime that can run Claude", () => {
    // Each lock against each kind of choice: which account the run binds,
    // and whether the person is told their choice is set aside.
    const cases: Array<{
      lock: AgentRuntimeAccountLock;
      agentAuthentication: "provider" | "subscription";
      row: "subscription" | "provider" | null;
      expected: "subscription" | "own";
      ignored: boolean;
    }> = [
      {
        lock: "subscription",
        agentAuthentication: "subscription",
        row: null,
        expected: "subscription",
        ignored: false,
      },
      {
        lock: "subscription",
        agentAuthentication: "subscription",
        row: "subscription",
        expected: "subscription",
        ignored: false,
      },
      {
        lock: "subscription",
        agentAuthentication: "subscription",
        row: "provider",
        expected: "subscription",
        ignored: true,
      },
      {
        lock: "key",
        agentAuthentication: "provider",
        row: null,
        expected: "own",
        ignored: false,
      },
      {
        lock: "key",
        agentAuthentication: "provider",
        row: "subscription",
        expected: "own",
        ignored: true,
      },
      // The agent's company key is what the lock gives anyway: the choice is
      // not reported as set aside, and the lock decides the run.
      {
        lock: "key",
        agentAuthentication: "provider",
        row: "provider",
        expected: "own",
        ignored: false,
      },
    ];
    for (const { lock, agentAuthentication, row, expected, ignored } of cases) {
      test(`${lock} lock with a ${row ?? "missing"} choice runs on the ${expected} account`, async ({
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
        if (row) await choose(agent, row);
        const runtime = {
          ...claudeCodeRuntime(agent, agentAuthentication),
          accountLock: lock,
        };

        const run = await launch({ agent, runtime });
        await expect(ready({ agent, runtime })).resolves.toBeUndefined();
        const { choiceIgnored, account } =
          await preflightAgentRuntimeModelCompatibility({
            runtime,
            agent,
            agentId: agent.id,
            organizationId,
            userId: author.id,
          });

        if (ignored) {
          expect(choiceIgnored).toBe(
            `This agent is locked to ${lock === "key" ? "a company API key" : "each person's own subscription"}, so your own choice is not used.`,
          );
          expect(account.source).toBe("agent");
        } else {
          expect(choiceIgnored).toBeNull();
          expect(account.source).toBe(
            row && lock !== "key" ? "choice" : "agent",
          );
        }
        if (expected === "subscription") {
          expect(await isPassthrough(run.virtualApiKeyId)).toBe(true);
          expect(run.spec.env.ARCHESTRA_AGENT_RUNTIME_MODEL).toBe(
            DEFAULT_CLAUDE_CODE_MODEL,
          );
        } else {
          expect(await boundKeyId(run.virtualApiKeyId)).toEqual([own.key.id]);
          // The key and the model go together: a lock pins both.
          expect(run.spec.env.ARCHESTRA_AGENT_RUNTIME_MODEL).toBe(
            own.model.modelId,
          );
        }
      });
    }

    test("a key lock whose key does not serve its model is the agent's to fix, even for a person who chose the company key", async ({
      makeAgent,
    }) => {
      const { agent } = await agentWith({
        makeAgent,
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
      });
      const other = await makeKeyWithModel({
        organizationId,
        provider: "anthropic",
        modelId: "claude-opus-4-6",
      });
      await choose(agent, "provider");
      const resolve = (modelId: string | null) =>
        getResolvedAgentRuntimeModelCompatibility({
          runtime: {
            ...claudeCodeRuntime(agent, "provider"),
            accountLock: "key",
          },
          agent: { ...agent, modelId },
          agentId: agent.id,
          organizationId,
          userId: author.id,
        });

      // Choosing again would change nothing: the lock runs the same pair.
      const broken = await resolve(other.model.id);
      expect(broken.accountError).toBe(
        `${KEY_LOCK_BROKEN_PAIR} Someone who can edit the agent must choose them again.`,
      );
      expect(broken.accountErrorFromChoice).toBe(false);
      expect(broken.accountErrorFromModel).toBe(false);

      // With no model set, it is the person's to pick, under the lock too.
      const open = await resolve(null);
      expect(open.accountError).toBe(CHOOSE_MODEL);
      expect(open.accountErrorFromChoice).toBe(false);
      expect(open.accountErrorFromModel).toBe(true);
    });

    test("a subscription lock refuses an agent whose own account is a company key", async ({
      makeAgent,
    }) => {
      const { agent } = await agentWith({
        makeAgent,
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
      });
      const runtime = {
        ...claudeCodeRuntime(agent, "provider"),
        accountLock: "subscription" as const,
      };

      await expect(launch({ agent, runtime })).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining(
          "locked to each person's own subscription",
        ),
      });
      await expect(ready({ agent, runtime })).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining(
          "locked to each person's own subscription",
        ),
      });
    });

    test("a key lock refuses an agent set to a subscription", async ({
      makeAgent,
    }) => {
      const { agent } = await agentWith({
        makeAgent,
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
      });
      const runtime = {
        ...claudeCodeRuntime(agent, "subscription"),
        accountLock: "key" as const,
      };

      await expect(launch({ agent, runtime })).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining(
          "locked to a company API key, but this run would use another key than the one set for it, or none",
        ),
      });
    });
  });

  describe("the key a run binds", () => {
    test("once a key-locked agent's key is deleted, its connection is each person's to choose, and the default until they do", async ({
      makeAgent,
    }) => {
      const { agent, own } = await agentWith({
        makeAgent,
        provider: "openai",
        modelId: "gpt-5.4",
      });
      // Another usable company key, which the organization's default gives.
      const fallback = await makeKeyWithModel({
        organizationId,
        provider: "openai",
        modelId: "gpt-5.4",
      });
      await LlmProviderApiKeyModel.delete(own.key.id);
      const reloaded = await AgentModel.findById(agent.id);
      assert(reloaded);
      expect(reloaded.llmApiKeyId).toBeNull();
      const runtime = {
        ...genericRuntime(reloaded, "openai_chat"),
        accountLock: "key" as const,
      };

      // The agent sets no connection any more: still a company API key.
      const run = await launch({ agent: reloaded, runtime });
      expect(await boundKeyId(run.virtualApiKeyId)).toEqual([fallback.key.id]);
      await expect(
        ready({ agent: reloaded, runtime }),
      ).resolves.toBeUndefined();
    });

    test("once a key-locked agent's key is deleted, a person who had picked that connection must choose again, never the default", async ({
      makeAgent,
    }) => {
      const { agent, own } = await agentWith({
        makeAgent,
        provider: "openai",
        modelId: "gpt-5.4",
      });
      // Another usable company key, which the organization's default gives.
      await makeKeyWithModel({
        organizationId,
        provider: "openai",
        modelId: "gpt-5.4",
      });
      // They picked the connection before the agent set it: a pick of a
      // connection the agent sets is refused when it is saved.
      await AgentRuntimeUserAccountModel.upsert({
        agentId: agent.id,
        userId: author.id,
        authentication: "provider",
        llmApiKeyId: own.key.id,
        modelId: null,
      });
      await LlmProviderApiKeyModel.delete(own.key.id);
      const reloaded = await AgentModel.findById(agent.id);
      assert(reloaded);
      const runtime = {
        ...genericRuntime(reloaded, "openai_chat"),
        accountLock: "key" as const,
      };

      const refused =
        "Your own account for this agent no longer works. The connection you chose no longer exists. Choose your account again.";
      await expect(launch({ agent: reloaded, runtime })).rejects.toMatchObject({
        statusCode: 409,
        message: refused,
      });
      await expect(ready({ agent: reloaded, runtime })).rejects.toMatchObject({
        statusCode: 409,
        message: refused,
      });
    });

    test("a key lock refuses the run where an unlocked run would swap keys", async ({
      makeAgent,
    }) => {
      // A vLLM key serves only its own endpoint's models. The agent's key does
      // not serve its model; another key of the organization does, and an
      // unlocked run swaps to it.
      const pinned = await makeKeyWithModel({
        organizationId,
        provider: "vllm",
        modelId: "local-small",
      });
      const serving = await makeKeyWithModel({
        organizationId,
        provider: "vllm",
        modelId: "local-large",
      });
      const agent = await makeAgent({
        organizationId,
        authorId: author.id,
        agentType: "agent",
        llmApiKeyId: pinned.key.id,
        modelId: serving.model.id,
      });
      const unlocked = genericRuntime(agent, "openai_chat");
      const run = await launch({ agent, runtime: unlocked });
      expect(await boundKeyId(run.virtualApiKeyId)).toEqual([serving.key.id]);

      // Locked, the agent's key and model must be a linked pair: no swap,
      // no organization default.
      const locked = { ...unlocked, accountLock: "key" as const };
      await expect(launch({ agent, runtime: locked })).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining(KEY_LOCK_BROKEN_PAIR),
      });
      await expect(ready({ agent, runtime: locked })).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining(KEY_LOCK_BROKEN_PAIR),
      });
    });

    test("once a key-locked agent's model is deleted, the run waits for the person to pick one of its key's models", async ({
      makeAgent,
    }) => {
      const { agent, own } = await agentWith({
        makeAgent,
        provider: "openai",
        modelId: "gpt-5.4-locked-model",
      });
      // Another key and model, which the organization's default would give.
      const other = await makeKeyWithModel({
        organizationId,
        provider: "openai",
        modelId: "gpt-5.4-mini",
      });
      await ModelModel.delete(own.model.provider, own.model.modelId);
      const reloaded = await AgentModel.findById(agent.id);
      assert(reloaded);
      expect(reloaded.modelId).toBeNull();
      const runtime = {
        ...genericRuntime(reloaded, "openai_chat"),
        accountLock: "key" as const,
      };

      // The agent's key still holds for everyone: never the default.
      await expect(launch({ agent: reloaded, runtime })).rejects.toMatchObject({
        statusCode: 409,
        message: CHOOSE_MODEL,
      });
      await expect(ready({ agent: reloaded, runtime })).rejects.toMatchObject({
        statusCode: 409,
        message: CHOOSE_MODEL,
      });

      await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(own.key.id, [
        other.model.id,
      ]);
      await AgentRuntimeUserAccountModel.upsert({
        agentId: agent.id,
        userId: author.id,
        authentication: "provider",
        modelId: other.model.id,
      });
      const run = await launch({ agent: reloaded, runtime });
      expect(await boundKeyId(run.virtualApiKeyId)).toEqual([own.key.id]);
      expect(run.spec.env.ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL).toBe(
        "gpt-5.4-mini",
      );

      // Once the model they picked is deleted too, the run names their own
      // pick as what stopped working.
      await ModelModel.delete(other.model.provider, other.model.modelId);
      await expect(launch({ agent: reloaded, runtime })).rejects.toMatchObject({
        statusCode: 409,
        message:
          "Your own account for this agent no longer works. The model you chose no longer exists. Choose your account again.",
      });
    });

    test("a key lock refuses the agent's key once it holds a personal subscription", async ({
      makeAgent,
    }) => {
      // The pinned key now carries someone's own ChatGPT sign-in, which is
      // never bound for other people's runs.
      const replaced = await makeKeyWithModel({
        organizationId,
        provider: "openai",
        modelId: "gpt-5.4",
        userId: author.id,
        apiKeyValue: "chatgpt-oauth:example-subscription",
      });
      const agent = await makeAgent({
        organizationId,
        authorId: author.id,
        agentType: "agent",
        llmApiKeyId: replaced.key.id,
        modelId: replaced.model.id,
      });
      const runtime = {
        ...genericRuntime(agent, "openai_chat"),
        accountLock: "key" as const,
      };

      await expect(launch({ agent, runtime })).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining(
          "locked to a company API key, but this run would use a personal subscription",
        ),
      });
    });

    test("a key lock refuses a bound key of another provider than the selected model", async () => {
      const { key } = await makeKeyWithModel({
        organizationId,
        provider: "openai",
        modelId: "gpt-5.4",
      });

      await expect(
        assertRunHonoursAccountLock({
          lock: "key",
          companyConnectionId: key.id,
          claudeSubscription: false,
          boundKeyId: key.id,
          provider: "gemini",
          runtimeCommand: null,
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining(
          "this run selected a gemini model for its openai key",
        ),
      });
    });
  });

  describe("runs with no person", () => {
    // Service accounts, teams, the organization and OAuth clients have no
    // account of their own: under any lock they run on the agent's own account.
    const actors = async (fixtures: {
      makeServiceAccount: (organizationId: string) => Promise<{ id: string }>;
      makeTeam: (
        organizationId: string,
        createdBy: string,
      ) => Promise<{ id: string }>;
    }): Promise<Array<[string, A2AActor]>> => [
      [
        "a service account",
        {
          kind: "serviceAccount",
          id: (await fixtures.makeServiceAccount(organizationId)).id,
          organizationId,
        },
      ],
      [
        "a team",
        {
          kind: "team",
          id: (await fixtures.makeTeam(organizationId, author.id)).id,
          organizationId,
        },
      ],
      [
        "the organization",
        { kind: "organization", id: organizationId, organizationId },
      ],
      [
        "an OAuth client",
        { kind: "oauthClient", id: "preview-oauth-client", organizationId },
      ],
    ];

    for (const lock of [null, "key"] as const) {
      test(`under ${lock ?? "no"} lock, they bind the agent's own key and ignore a person's row`, async ({
        makeAgent,
        makeServiceAccount,
        makeTeam,
      }) => {
        const { agent, own } = await agentWith({
          makeAgent,
          provider: "anthropic",
          modelId: "claude-sonnet-4-6",
        });
        // A person's own runs would use their Claude subscription.
        await choose(agent, "subscription");

        const runtime: ResolvedAgentRuntime = {
          ...claudeCodeRuntime(agent, "provider"),
          accountLock: lock,
        };
        const { llm, account } = await preflightAgentRuntimeModelCompatibility({
          runtime,
          agent,
          agentId: agent.id,
          organizationId,
          userId: "system",
        });
        // The launch binds through the same function; its MCP gateway token
        // for these actors is outside what this test is about.
        for (const [label, actor] of await actors({
          makeServiceAccount,
          makeTeam,
        })) {
          const key = await bindRunProviderKey({
            organizationId,
            actor,
            provider: llm.selectedProvider,
            model: llm.selectedModel,
            companyConnectionId: agent.llmApiKeyId,
            account,
            accountLock: lock,
            runtimeCommand: runtime.command?.[0],
          });
          expect(key.id, label).toBe(own.key.id);
        }
      });
    }

    test("under a subscription lock, they are refused because there is no person to sign in", async ({
      makeAgent,
      makeServiceAccount,
      makeTeam,
    }) => {
      const { agent } = await agentWith({
        makeAgent,
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
      });

      for (const [label, actor] of await actors({
        makeServiceAccount,
        makeTeam,
      })) {
        const error = await launch({
          agent,
          runtime: {
            ...claudeCodeRuntime(agent, "subscription"),
            accountLock: "subscription",
          },
          actor,
        }).catch((caught: unknown) => caught);
        expect(error, label).toMatchObject({
          statusCode: 409,
          message:
            "A personal Claude subscription requires a run acting as a signed-in user.",
        });
      }
    });
  });

  describe("on the maintained Codex runtime", () => {
    test("a key lock runs on the agent's OpenAI key without ChatGPT", async ({
      makeAgent,
    }) => {
      const { agent, own } = await agentWith({
        makeAgent,
        provider: "openai",
        modelId: "gpt-5.4",
      });

      const run = await launch({
        agent,
        runtime: { ...codexRuntime(agent), accountLock: "key" },
      });

      expect(await boundKeyId(run.virtualApiKeyId)).toEqual([own.key.id]);
    });

    test("a subscription lock on an agent that stores a company OpenAI key binds the person's own ChatGPT", async ({
      makeAgent,
    }) => {
      const { agent, own } = await agentWith({
        makeAgent,
        provider: "openai",
        modelId: "gpt-5.4",
      });
      const runtime: ResolvedAgentRuntime = {
        ...codexRuntime(agent),
        accountLock: "subscription",
      };

      const refusal = {
        statusCode: 409,
        message:
          "Connect your own ChatGPT Subscription before starting this Agent. It is locked to each person's own subscription.",
      };
      await expect(launch({ agent, runtime })).rejects.toMatchObject(refusal);
      await expect(ready({ agent, runtime })).rejects.toMatchObject(refusal);

      const chatGpt = await makeKeyWithModel({
        organizationId,
        provider: "openai",
        modelId: "gpt-5.4",
        userId: author.id,
        apiKeyValue: "chatgpt-oauth:example-subscription",
      });
      const run = await launch({ agent, runtime });

      await expect(ready({ agent, runtime })).resolves.toBeUndefined();
      const bound = await boundKeyId(run.virtualApiKeyId);
      expect(bound).toEqual([chatGpt.key.id]);
      expect(bound).not.toContain(own.key.id);
    });
  });

  describe("the company API key with no connection set or chosen", () => {
    const CHOOSE_CONNECTION =
      "Choose a connection on the agent's page to run this agent.";

    // The person may use both: a company connection shared with everyone,
    // and a key of their own, which ranks first among the keys they may use.
    const sharedAndOwn = async (ownApiKeyValue?: string) => ({
      shared: await makeKeyWithModel({
        organizationId,
        provider: "openai",
        modelId: "gpt-5.4",
      }),
      own: await makeKeyWithModel({
        organizationId,
        provider: "openai",
        modelId: "gpt-5.4",
        userId: author.id,
        apiKeyValue: ownApiKeyValue,
      }),
    });
    const CHATGPT = "chatgpt-oauth:example-subscription";
    const agentThatStoresNone = (
      makeAgent: (overrides: Record<string, unknown>) => Promise<Agent>,
    ) => makeAgent({ organizationId, authorId: author.id, agentType: "agent" });

    test("a key lock runs on the shared company connection, not on the person's own ChatGPT subscription", async ({
      makeAgent,
    }) => {
      const { shared } = await sharedAndOwn(CHATGPT);
      const agent = await agentThatStoresNone(makeAgent);

      const run = await launch({
        agent,
        runtime: { ...codexRuntime(agent), accountLock: "key" },
      });

      expect(await boundKeyId(run.virtualApiKeyId)).toEqual([shared.key.id]);
    });

    test("a person who chose the company API key runs on the shared company connection, not on their own ChatGPT subscription", async ({
      makeAgent,
    }) => {
      const { shared } = await sharedAndOwn(CHATGPT);
      const agent = await agentThatStoresNone(makeAgent);
      await choose(agent, "provider");

      const run = await launch({ agent, runtime: codexRuntime(agent) });

      expect(await boundKeyId(run.virtualApiKeyId)).toEqual([shared.key.id]);
    });

    test("an agent whose own account is the company API key runs a person who chose nothing on the shared connection, not on their own API key", async ({
      makeAgent,
    }) => {
      const { shared } = await sharedAndOwn();
      const agent = await agentThatStoresNone(makeAgent);

      const run = await launch({
        agent,
        runtime: genericRuntime(agent, "openai_chat"),
      });

      expect(await boundKeyId(run.virtualApiKeyId)).toEqual([shared.key.id]);
    });

    test.for([
      ["a ChatGPT subscription", CHATGPT],
      ["an API key", undefined],
    ] as const)("a person whose only key is %s of their own is told to choose a connection", async ([
      ,
      ownApiKeyValue,
    ], { makeAgent }) => {
      await makeKeyWithModel({
        organizationId,
        provider: "openai",
        modelId: "gpt-5.4",
        userId: author.id,
        apiKeyValue: ownApiKeyValue,
      });
      const agent = await agentThatStoresNone(makeAgent);
      const runtime = { ...codexRuntime(agent), accountLock: "key" as const };

      await expect(launch({ agent, runtime })).rejects.toMatchObject({
        statusCode: 409,
        message: CHOOSE_CONNECTION,
      });
      await expect(ready({ agent, runtime })).rejects.toMatchObject({
        statusCode: 409,
        message: CHOOSE_CONNECTION,
      });
    });

    test("a person runs on their own API key once they pick it themselves", async ({
      makeAgent,
    }) => {
      const { own } = await sharedAndOwn();
      const agent = await agentThatStoresNone(makeAgent);
      await AgentRuntimeUserAccountModel.upsert({
        agentId: agent.id,
        userId: author.id,
        authentication: "provider",
        llmApiKeyId: own.key.id,
        modelId: own.model.id,
      });

      const run = await launch({
        agent,
        runtime: genericRuntime(agent, "openai_chat"),
      });

      expect(await boundKeyId(run.virtualApiKeyId)).toEqual([own.key.id]);
    });

    test("an agent saved before people could choose resolves as it did: the person's own key first", async ({
      makeAgent,
    }) => {
      const { own } = await sharedAndOwn();
      const agent = await agentThatStoresNone(makeAgent);

      const run = await launch({
        agent,
        runtime: {
          ...genericRuntime(agent, "openai_chat"),
          accountLock: OWN_ACCOUNT_ONLY,
        },
      });

      expect(await boundKeyId(run.virtualApiKeyId)).toEqual([own.key.id]);
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
    resources: null,
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
