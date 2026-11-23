import { vi } from "vitest";
import { serviceAccountUserId } from "@/auth/service-account-user-id";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { agentSandboxApi } from "@/k8s/agent-runtime/sandbox-api";
import {
  AgentModel,
  AgentRuntimeUserAccountModel,
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  OrganizationModel,
} from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent, User } from "@/types";
import { drainBackgroundWork } from "@/utils/background-work";
import {
  accountAudits,
  buildAccountTestApp,
  companyAccountSetBy,
  makeKeyWithModel,
  NO_COMPANY_ACCOUNT,
  runtimeFor,
} from "./agent-runtime-account.test-helpers";

vi.mock("@/observability");

describe("PUT /api/agents/:id/runtime/account", () => {
  const ctx = {} as { user: User; organizationId: string };
  let app: FastifyInstanceWithZod;
  let agent: Agent;

  beforeEach(async ({ makeAgent, makeMember, makeOrganization, makeUser }) => {
    ctx.organizationId = (await makeOrganization()).id;
    ctx.user = await makeUser();
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    agent = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      runtime: runtimeFor({ inferenceProtocol: "openai_responses" }),
    });
    app = await buildAccountTestApp(ctx);
    vi.spyOn(agentSandboxApi, "isInstalled", "get").mockReturnValue(true);
  });

  const put = (payload: Record<string, unknown>, agentId = agent.id) =>
    app.inject({
      method: "PUT",
      url: `/api/agents/${agentId}/runtime/account`,
      payload,
    });

  /** Give the agent a company key and model of its own. */
  const giveCompanyKey = async (agentId = agent.id) => {
    const own = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4",
    });
    await AgentModel.update(agentId, {
      llmApiKeyId: own.key.id,
      modelId: own.model.id,
    });
    return own;
  };

  const storedChoice = (agentId = agent.id, userId = ctx.user.id) =>
    AgentRuntimeUserAccountModel.find({ agentId, userId });

  const read = async (agentId = agent.id) =>
    (
      await app.inject({
        method: "GET",
        url: `/api/agents/${agentId}/runtime/account`,
      })
    ).json();
  const preflight = async (agentId = agent.id) =>
    (
      await app.inject({
        method: "GET",
        url: `/api/agents/${agentId}/runtime/preflight`,
      })
    ).json();

  // The agents here run on an image with no personal subscription: the
  // company option is their only way, so its problems go to their editors.
  const BROKEN_COMPANY_KEY =
    "This agent's own API key or model no longer works. Someone who can edit the agent must choose them again.";

  test("keeps each person's choice to themselves on a shared agent", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    // A runtime that offers both ways: the agent's company key, or each
    // person's own ChatGPT subscription.
    agent = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      runtime: runtimeFor({
        inferenceProtocol: "openai_responses",
        command: ["archestra-codex"],
      }),
    });
    const own = await giveCompanyKey();
    const author = ctx.user;
    const colleague = await makeUser();
    await makeMember(colleague.id, ctx.organizationId, { role: "member" });

    const saved = await put({ authentication: "provider" });
    expect(saved.statusCode, saved.body).toBe(200);
    ctx.user = colleague;
    const theirs = await put({ authentication: "subscription" });
    expect(theirs.statusCode, theirs.body).toBe(200);

    const choiceOf = async (user: User) => {
      ctx.user = user;
      return (await read()).choice;
    };
    expect(await choiceOf(author)).toEqual({
      authentication: "provider",
      llmApiKeyId: null,
      modelId: null,
      claudeModel: null,
    });
    expect(await choiceOf(colleague)).toEqual({
      authentication: "subscription",
      llmApiKeyId: null,
      modelId: null,
      claudeModel: null,
    });
    // The agent's own account is untouched.
    expect(await AgentModel.findById(agent.id)).toMatchObject({
      llmApiKeyId: own.key.id,
      modelId: own.model.id,
    });
  });

  test("refuses a person without use on the agent, as a run does", async ({
    makeCustomRole,
    makeMember,
    makeUser,
  }) => {
    await giveCompanyKey();
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

    const refused = await put({ authentication: "provider" });
    const run = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/runs`,
      payload: { message: "Start" },
    });

    expect(refused.statusCode).toBe(403);
    expect(run.statusCode).toBe(403);
    expect(refused.json().error.message).toBe(run.json().error.message);
    expect(await storedChoice(agent.id, reader.id)).toBeNull();
  });

  test("a run started through the run route uses the caller's own choice", async () => {
    // A stored choice whose connection was deleted since, leaving its model
    // alone: only the route that passes the agent's id to the model check
    // can see it.
    const { model } = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4",
    });
    await AgentRuntimeUserAccountModel.upsert({
      agentId: agent.id,
      userId: ctx.user.id,
      authentication: "provider",
      modelId: model.id,
    });

    const run = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/runs`,
      payload: { message: "Start" },
    });

    expect(run.statusCode).toBe(409);
    expect(run.json().error.message).toBe(
      "Your own account for this agent no longer works. The model you chose has no connection any more. Choose your account again.",
    );
  });

  test("saves the agent's company key for a person the key is not shared with", async ({
    makeMember,
    makeUser,
  }) => {
    const own = await giveCompanyKey();
    const scope = {
      organizationId: ctx.organizationId,
      resource: "llmProviderApiKey" as const,
      scope: own.key.id,
    };
    const policy = await ResourcePermissionPolicyModel.find(scope);
    await ResourcePermissionPolicyModel.replace({
      ...scope,
      revision: policy?.revision ?? 0,
      grants: [],
    });
    const colleague = await makeUser();
    await makeMember(colleague.id, ctx.organizationId, { role: "member" });
    ctx.user = colleague;

    // It is the agent's key, as their runs without a choice already use it.
    const saved = await put({ authentication: "provider" });

    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({
      companyKey: true,
      choice: { authentication: "provider", modelId: null },
      choiceError: null,
    });
  });

  test("saves the company API key on an agent that sets no connection, or its connection alone", async () => {
    // The agent runs on the organization's default: nothing of its own.
    const withoutPair = await put({ authentication: "provider" });
    expect(withoutPair.statusCode, withoutPair.body).toBe(200);
    expect(withoutPair.json()).toMatchObject({
      companyKey: false,
      companyAccount: NO_COMPANY_ACCOUNT,
      choice: { authentication: "provider", llmApiKeyId: null, modelId: null },
      choiceError: null,
    });

    const own = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4",
    });
    // Its connection alone leaves the model to each person.
    await AgentModel.update(agent.id, {
      llmApiKeyId: own.key.id,
      modelId: null,
    });
    const onItsConnection = await put({ authentication: "provider" });
    expect(onItsConnection.statusCode, onItsConnection.body).toBe(200);
    expect(onItsConnection.json()).toMatchObject({
      companyKey: false,
      companyAccount: {
        connection: { id: own.key.id, fixedBy: "agent" },
        model: { id: null, fixedBy: null },
        usesOrganizationDefault: false,
      },
    });
    // A model stands for nothing without its connection: the default.
    await AgentModel.update(agent.id, {
      llmApiKeyId: null,
      modelId: own.model.id,
    });
    const onTheDefault = await put({ authentication: "provider" });
    expect(onTheDefault.statusCode, onTheDefault.body).toBe(200);
    expect(onTheDefault.json()).toMatchObject({
      companyKey: true,
      companyAccount: {
        connection: { id: own.key.id, fixedBy: null },
        model: { id: own.model.id, fixedBy: null },
        usesOrganizationDefault: true,
      },
    });
  });

  test("refuses the company key of an agent whose key is another organization's", async ({
    makeOrganization,
  }) => {
    const other = await makeOrganization();
    const { key, model } = await makeKeyWithModel({
      organizationId: other.id,
      provider: "openai",
      modelId: "gpt-5.4",
    });
    await AgentModel.update(agent.id, {
      llmApiKeyId: key.id,
      modelId: model.id,
    });

    const refused = await put({ authentication: "provider" });

    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toBe(BROKEN_COMPANY_KEY);
    expect(await storedChoice()).toBeNull();
  });

  test("refuses a service account, which has no runs of its own", async ({
    makeServiceAccountToken,
  }) => {
    await giveCompanyKey();
    const { serviceAccount } = await makeServiceAccountToken({
      organizationId: ctx.organizationId,
      role: "admin",
    });
    ctx.user = { ...ctx.user, id: serviceAccountUserId(serviceAccount.id) };

    const refused = await put({ authentication: "provider" });

    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toBe(
      "Only a signed-in person can choose an account for their own runs.",
    );
    expect(await storedChoice()).toBeNull();
  });

  test("refuses the company key of an agent whose key is a personal subscription", async () => {
    const { key, model } = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4",
      userId: ctx.user.id,
      apiKeyValue: "chatgpt-oauth:example-subscription",
    });
    await AgentModel.update(agent.id, {
      llmApiKeyId: key.id,
      modelId: model.id,
    });

    const refused = await put({ authentication: "provider" });

    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toBe(
      "This agent's own key is a personal subscription, not a company API key. Someone who can edit the agent must choose another.",
    );
    expect(await storedChoice()).toBeNull();
  });

  test("refuses the company key of an agent whose key the runtime cannot run", async ({
    makeAgent,
  }) => {
    const { key, model } = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "gemini",
      modelId: "gemini-runtime-choice-test",
    });
    const codex = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      llmApiKeyId: key.id,
      modelId: model.id,
      runtime: runtimeFor({
        inferenceProtocol: "openai_responses",
        command: ["archestra-codex"],
      }),
    });

    const refused = await put({ authentication: "provider" }, codex.id);

    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toContain("Codex runtime requires");
  });

  test("refuses the company key of an agent whose key does not serve its model", async () => {
    const { key } = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4",
    });
    const other = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4-nano",
    });
    await AgentModel.update(agent.id, {
      llmApiKeyId: key.id,
      modelId: other.model.id,
    });

    const refused = await put({ authentication: "provider" });

    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toBe(BROKEN_COMPANY_KEY);
  });

  test("sends the person to their own subscription for the same problem on a runtime that has one", async ({
    makeAgent,
  }) => {
    const { key } = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4",
    });
    const other = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4-nano",
    });
    const onCodex = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      llmApiKeyId: key.id,
      modelId: other.model.id,
      runtime: runtimeFor({
        command: ["archestra-codex"],
        inferenceProtocol: "openai_responses",
      }),
    });

    const refused = await put({ authentication: "provider" }, onCodex.id);

    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toBe(
      "This agent's own API key or model no longer works. Choose your personal subscription instead.",
    );
  });

  test("refuses a connection or model for a part the agent sets, its own included", async () => {
    const own = await giveCompanyKey();
    const other = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4-mini",
    });

    for (const modelId of [other.model.id, own.model.id]) {
      const refused = await put({ authentication: "provider", modelId });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.message).toBe(
        "This agent sets the model of its company API key, so you cannot choose another.",
      );
    }
    for (const llmApiKeyId of [other.key.id, own.key.id]) {
      const refused = await put({ authentication: "provider", llmApiKeyId });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.message).toBe(
        "This agent sets the connection of its company API key, so you cannot choose another.",
      );
    }
    expect(await storedChoice()).toBeNull();
    expect(await read()).toMatchObject({
      companyKey: true,
      companyAccount: companyAccountSetBy("agent", own),
    });
  });

  describe("on an agent that leaves its company API key to each person", () => {
    let member: User;
    let author: User;
    /** A connection shared with everyone, and one only administrators reach. */
    let shared: Awaited<ReturnType<typeof makeKeyWithModel>>;
    let restricted: Awaited<ReturnType<typeof makeKeyWithModel>>;

    beforeEach(async ({ makeMember, makeUser }) => {
      author = ctx.user;
      member = await makeUser();
      await makeMember(member.id, ctx.organizationId, { role: "member" });
      shared = await makeKeyWithModel({
        organizationId: ctx.organizationId,
        provider: "openai",
        modelId: "gpt-5.4",
      });
      restricted = await makeKeyWithModel({
        organizationId: ctx.organizationId,
        provider: "openai",
        modelId: "gpt-5.4-mini",
        adminsOnly: true,
      });
    });

    const as = <T>(user: User, request: () => Promise<T>) => {
      ctx.user = user;
      return request();
    };
    const company = (parts: { llmApiKeyId?: string; modelId?: string }) => ({
      authentication: "provider",
      ...parts,
    });

    test("with nothing set, a person picks a connection they may use and one of its models", async () => {
      const chosen = await as(member, () =>
        put(company({ llmApiKeyId: shared.key.id, modelId: shared.model.id })),
      );

      expect(chosen.statusCode, chosen.body).toBe(200);
      expect(chosen.json()).toMatchObject({
        companyKey: true,
        companyAccount: {
          connection: {
            id: shared.key.id,
            name: shared.key.name,
            provider: "openai",
            fixedBy: null,
          },
          model: { id: shared.model.id, name: "gpt-5.4", fixedBy: null },
          usesOrganizationDefault: false,
        },
        choice: {
          authentication: "provider",
          llmApiKeyId: shared.key.id,
          modelId: shared.model.id,
          claudeModel: null,
        },
        choiceError: null,
      });
      // Nobody's but theirs: the author is still on the organization's
      // default, which is whatever they may use.
      expect(await as(author, () => read())).toMatchObject({
        choice: null,
        companyAccount: { usesOrganizationDefault: true },
      });
      expect(await AgentModel.findById(agent.id)).toMatchObject({
        llmApiKeyId: null,
        modelId: null,
      });
    });

    test("once the connection the agent sets is deleted, each person picks from the connections and models they may use, until the agent sets another", async () => {
      // The agent sets a connection and model for everyone.
      const locked = await makeKeyWithModel({
        organizationId: ctx.organizationId,
        provider: "openai",
        modelId: "gpt-5.4-locked",
      });
      await AgentModel.update(agent.id, {
        llmApiKeyId: locked.key.id,
        modelId: locked.model.id,
      });
      const own = company({
        llmApiKeyId: shared.key.id,
        modelId: shared.model.id,
      });
      expect((await as(member, () => put(own))).statusCode).toBe(409);

      await LlmProviderApiKeyModel.delete(locked.key.id);

      // Its model stays stored alone, and sets nothing for anyone: both
      // parts are each person's to pick.
      expect(await AgentModel.findById(agent.id)).toMatchObject({
        llmApiKeyId: null,
        modelId: locked.model.id,
      });
      expect((await as(member, () => read())).companyAccount).toMatchObject({
        connection: { fixedBy: null },
        model: { fixedBy: null },
      });
      // Among the connections they may use: not one only administrators
      // reach.
      const refused = await as(member, () =>
        put(
          company({
            llmApiKeyId: restricted.key.id,
            modelId: restricted.model.id,
          }),
        ),
      );
      expect(refused.statusCode).toBe(403);
      const picked = await as(member, () => put(own));
      expect(picked.statusCode, picked.body).toBe(200);
      expect(picked.json()).toMatchObject({
        companyAccount: {
          connection: { id: shared.key.id, fixedBy: null },
          model: { id: shared.model.id, fixedBy: null },
        },
        choiceError: null,
      });
      expect(await as(member, () => preflight())).toMatchObject({
        accountError: null,
      });

      // The agent sets another: it holds for everyone again, and their pick
      // is set aside without a word.
      const next = await makeKeyWithModel({
        organizationId: ctx.organizationId,
        provider: "openai",
        modelId: "gpt-5.4-next",
      });
      await AgentModel.update(agent.id, {
        llmApiKeyId: next.key.id,
        modelId: next.model.id,
      });
      expect(await as(member, () => read())).toMatchObject({
        companyAccount: companyAccountSetBy("agent", next),
        choiceError: null,
      });
    });

    test("a connection alone is saved, and their runs wait for its model", async () => {
      const chosen = await as(member, () =>
        put(company({ llmApiKeyId: shared.key.id })),
      );

      expect(chosen.statusCode, chosen.body).toBe(200);
      expect(chosen.json()).toMatchObject({
        companyKey: false,
        companyAccount: {
          connection: { id: shared.key.id, fixedBy: null },
          model: { id: null, fixedBy: null },
          usesOrganizationDefault: false,
        },
        choiceError: null,
      });
      expect(chosen.json().companyAccount).not.toHaveProperty("models");
      expect(await as(member, () => preflight())).toMatchObject({
        ready: false,
        accountError: "Choose a model on the agent's page to run this agent.",
        accountErrorFromChoice: false,
        accountErrorFromModel: true,
        accountErrorFromConnection: false,
      });
    });

    test("refuses a connection they may not use, a personal subscription, and a model that is not the connection's", async ({
      makeAgent,
      makeOrganization,
    }) => {
      const subscription = await makeKeyWithModel({
        organizationId: ctx.organizationId,
        provider: "openai",
        modelId: "gpt-5.4-own",
        userId: member.id,
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
      const refused: [object, number, string][] = [
        [
          { llmApiKeyId: restricted.key.id, modelId: restricted.model.id },
          403,
          "You cannot use this connection yourself. Choose one that is shared with you.",
        ],
        [
          { llmApiKeyId: subscription.key.id, modelId: subscription.model.id },
          400,
          "That connection is a personal subscription, not an API key. Choose a connection that holds an API key.",
        ],
        [
          { llmApiKeyId: foreign.key.id },
          400,
          "The selected connection does not exist.",
        ],
        [
          { llmApiKeyId: shared.key.id, modelId: restricted.model.id },
          400,
          "The selected model is not one of the connection's models. Choose one of them.",
        ],
        [
          { modelId: shared.model.id },
          400,
          "Choose a connection before its model.",
        ],
      ];
      for (const [parts, status, message] of refused) {
        const response = await as(member, () => put(company(parts)));
        expect(response.statusCode, JSON.stringify(parts)).toBe(status);
        expect(response.json().error.message).toContain(message);
      }
      expect(await storedChoice(agent.id, member.id)).toBeNull();

      // A connection the runtime cannot run on.
      const codex = await makeAgent({
        organizationId: ctx.organizationId,
        authorId: author.id,
        agentType: "agent",
        runtime: runtimeFor({
          inferenceProtocol: "openai_responses",
          command: ["archestra-codex"],
        }),
      });
      const unfit = await as(member, () =>
        put(
          company({ llmApiKeyId: gemini.key.id, modelId: gemini.model.id }),
          codex.id,
        ),
      );
      expect(unfit.statusCode, unfit.body).toBe(409);
      expect(unfit.json().error.message).toContain("Codex runtime requires");
      expect(await storedChoice(codex.id, member.id)).toBeNull();

      // A connection goes with the company API key only.
      const onSubscription = await as(member, () =>
        put(
          { authentication: "subscription", llmApiKeyId: shared.key.id },
          codex.id,
        ),
      );
      expect(onSubscription.statusCode).toBe(400);
      expect(onSubscription.json().error.message).toBe(
        "A connection goes only with a company API key. Leave it empty.",
      );
    });

    test("accepts their own API key, which nobody else's runs use", async () => {
      const mine = await makeKeyWithModel({
        organizationId: ctx.organizationId,
        provider: "openai",
        modelId: "gpt-5.4-nano",
        userId: member.id,
      });

      const chosen = await as(member, () =>
        put(company({ llmApiKeyId: mine.key.id, modelId: mine.model.id })),
      );

      expect(chosen.statusCode, chosen.body).toBe(200);
      expect(chosen.json()).toMatchObject({
        companyKey: true,
        companyAccount: {
          connection: { id: mine.key.id, fixedBy: null },
          model: { id: mine.model.id, fixedBy: null },
        },
      });
      expect(await as(author, () => read())).toMatchObject({ choice: null });
    });

    test("where the agent sets the connection, each person picks one of its models, whether or not they may read it", async () => {
      // A connection only administrators reach, set by the agent's builder.
      const second = await makeKeyWithModel({
        organizationId: ctx.organizationId,
        provider: "openai",
        modelId: "gpt-5.4-nano",
        adminsOnly: true,
      });
      await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(
        restricted.key.id,
        [restricted.model.id, second.model.id],
      );
      await AgentModel.update(agent.id, { llmApiKeyId: restricted.key.id });

      const before = await as(member, () => read());
      expect(before).toMatchObject({
        companyKey: false,
        companyAccount: {
          connection: {
            id: restricted.key.id,
            name: restricted.key.name,
            provider: "openai",
            fixedBy: "agent",
          },
          model: { id: null, name: null, fixedBy: null },
          usesOrganizationDefault: false,
        },
      });
      expect(
        before.companyAccount.models
          .map((model: { id: string }) => model.id)
          .sort(),
      ).toEqual([restricted.model.id, second.model.id].sort());

      // Another connection is not theirs to bring, nor a model of another.
      const ownConnection = await as(member, () =>
        put(company({ llmApiKeyId: shared.key.id, modelId: shared.model.id })),
      );
      expect(ownConnection.statusCode).toBe(409);
      expect(ownConnection.json().error.message).toBe(
        "This agent sets the connection of its company API key, so you cannot choose another.",
      );
      const foreignModel = await as(member, () =>
        put(company({ modelId: shared.model.id })),
      );
      expect(foreignModel.statusCode).toBe(400);
      expect(foreignModel.json().error.message).toBe(
        "The selected model is not one of the connection's models. Choose one of them.",
      );

      const theirs = await as(member, () =>
        put(company({ modelId: second.model.id })),
      );
      expect(theirs.statusCode, theirs.body).toBe(200);
      expect(theirs.json()).toMatchObject({
        companyKey: true,
        companyAccount: {
          connection: { id: restricted.key.id, fixedBy: "agent" },
          model: { id: second.model.id, name: "gpt-5.4-nano", fixedBy: null },
        },
        choice: { llmApiKeyId: null, modelId: second.model.id },
      });
      expect(await as(member, () => preflight())).toMatchObject({
        ready: true,
        accountError: null,
      });
      // The author picks another of its models for their own runs.
      const authors = await as(author, () =>
        put(company({ modelId: restricted.model.id })),
      );
      expect(authors.json()).toMatchObject({
        companyAccount: { model: { id: restricted.model.id } },
      });
      expect(await as(member, () => read())).toMatchObject({
        companyAccount: { model: { id: second.model.id } },
      });
    });

    test("a connection the agent sets since sets their pick aside: its model is theirs to pick again, and a model they pick for it that it stops serving is never swapped for the default", async () => {
      const second = await makeKeyWithModel({
        organizationId: ctx.organizationId,
        provider: "openai",
        modelId: "gpt-5.4-nano",
        adminsOnly: true,
      });
      await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(
        restricted.key.id,
        [restricted.model.id, second.model.id],
      );
      // With nothing set, the member picked a connection and one of its models.
      const picked = { llmApiKeyId: shared.key.id, modelId: shared.model.id };
      expect((await as(member, () => put(company(picked)))).statusCode).toBe(
        200,
      );
      const modelIsOpen = async () => {
        const account = await as(member, () => read());
        expect(account).toMatchObject({
          companyKey: false,
          companyAccount: {
            connection: { id: restricted.key.id, fixedBy: "agent" },
            model: { id: null, name: null, fixedBy: null },
            usesOrganizationDefault: false,
          },
          choiceError: null,
        });
        expect(
          account.companyAccount.models.map(
            (model: { id: string }) => model.id,
          ),
        ).toEqual(expect.arrayContaining([second.model.id]));
        const chooseModel =
          "Choose a model on the agent's page to run this agent.";
        expect(await as(member, () => preflight())).toMatchObject({
          ready: false,
          accountError: chooseModel,
          accountErrorFromChoice: false,
          accountErrorFromModel: true,
          accountErrorFromConnection: false,
        });
        const run = await as(member, () =>
          app.inject({
            method: "POST",
            url: `/api/agents/${agent.id}/runs`,
            payload: { message: "Start" },
          }),
        );
        expect(run.statusCode).toBe(409);
        expect(run.json().error.message).toBe(chooseModel);
      };

      // The builder sets another connection on the agent, and no model: the
      // member's stored pick stays as it is, and is simply not what runs.
      await AgentModel.update(agent.id, { llmApiKeyId: restricted.key.id });
      await modelIsOpen();
      expect(await storedChoice(agent.id, member.id)).toMatchObject(picked);

      // They pick one of that connection's models, and run.
      const repicked = await as(member, () =>
        put(company({ modelId: restricted.model.id })),
      );
      expect(repicked.statusCode, repicked.body).toBe(200);
      expect(await as(member, () => preflight())).toMatchObject({
        ready: true,
        accountError: null,
      });
      // The connection stops serving that model, and still serves the
      // organization's default: their run is not moved to the default, it
      // waits for them to choose again.
      await OrganizationModel.patch(ctx.organizationId, {
        defaultModelId: second.model.id,
        defaultLlmApiKeyId: restricted.key.id,
      });
      await LlmProviderApiKeyModelLinkModel.unlinkModelFromApiKey({
        apiKeyId: restricted.key.id,
        provider: "openai",
        modelId: restricted.model.modelId,
      });
      const stale =
        "Your own account for this agent no longer works. The model you chose is no longer one of its connection's models. Choose your account again.";
      expect(await as(member, () => read())).toMatchObject({
        choiceError: stale,
      });
      expect(await as(member, () => preflight())).toMatchObject({
        ready: false,
        accountError: stale,
        accountErrorFromChoice: true,
      });

      // The builder sets the model as well: everything resolves, and nothing
      // is asked of someone whose stored pick names another.
      await AgentModel.update(agent.id, { modelId: second.model.id });
      expect(await as(member, () => read())).toMatchObject({
        companyKey: true,
        companyAccount: {
          connection: { id: restricted.key.id, fixedBy: "agent" },
          model: { id: second.model.id, fixedBy: "agent" },
        },
        choiceError: null,
      });
      expect(await as(member, () => preflight())).toMatchObject({
        ready: true,
        accountError: null,
        accountErrorFromChoice: false,
        accountErrorFromModel: false,
      });
    });

    test("a choice that no longer works is refused at the run, and never moved to the default", async () => {
      const choose = (parts: { llmApiKeyId?: string; modelId?: string }) =>
        as(member, () => put(company(parts)));
      const stale = async (reason: string) => {
        const error = `Your own account for this agent no longer works. ${reason} Choose your account again.`;
        expect(await as(member, () => read())).toMatchObject({
          companyKey: false,
          choiceError: error,
        });
        expect(await as(member, () => preflight())).toMatchObject({
          ready: false,
          accountError: error,
          accountErrorFromChoice: true,
          accountErrorFromModel: false,
          accountErrorFromConnection: false,
        });
        const run = await as(member, () =>
          app.inject({
            method: "POST",
            url: `/api/agents/${agent.id}/runs`,
            payload: { message: "Start" },
          }),
        );
        expect(run.statusCode).toBe(409);
        expect(run.json().error.message).toBe(error);
      };
      // The organization's default is there to fall to, and is not used.
      const fallback = await makeKeyWithModel({
        organizationId: ctx.organizationId,
        provider: "openai",
        modelId: "gpt-5.4-nano",
      });
      const pair = { llmApiKeyId: shared.key.id, modelId: shared.model.id };
      expect((await choose(pair)).statusCode).toBe(200);

      // Its model is no longer one of the connection's.
      await LlmProviderApiKeyModelLinkModel.deleteLinksForApiKey(shared.key.id);
      await stale(
        "The model you chose is no longer one of its connection's models.",
      );

      // The connection is no longer theirs to use.
      await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(shared.key.id, [
        shared.model.id,
      ]);
      expect(await as(member, () => preflight())).toMatchObject({
        accountError: null,
      });
      const scope = {
        organizationId: ctx.organizationId,
        resource: "llmProviderApiKey" as const,
        scope: shared.key.id,
      };
      const policy = await ResourcePermissionPolicyModel.find(scope);
      await ResourcePermissionPolicyModel.replace({
        ...scope,
        revision: policy?.revision ?? 0,
        grants: [],
      });
      await stale("You can no longer use the connection you chose.");

      // The connection is deleted, and its model stays stored alone.
      await LlmProviderApiKeyModel.delete(shared.key.id);
      expect(await storedChoice(agent.id, member.id)).toMatchObject({
        llmApiKeyId: null,
        modelId: shared.model.id,
      });
      await stale("The connection you chose no longer exists.");

      // A connection picked without a model leaves no id behind once it is
      // deleted, and the run still does not move to the default.
      const alone = await makeKeyWithModel({
        organizationId: ctx.organizationId,
        provider: "openai",
        modelId: "gpt-5.4-alone",
      });
      expect((await choose({ llmApiKeyId: alone.key.id })).statusCode).toBe(
        200,
      );
      await LlmProviderApiKeyModel.delete(alone.key.id);
      expect(await storedChoice(agent.id, member.id)).toMatchObject({
        llmApiKeyId: null,
        modelId: null,
      });
      await stale("The connection you chose no longer exists.");

      // Nor does a connection deleted with the one model it served, which
      // the deletion removes after it.
      const both = await makeKeyWithModel({
        organizationId: ctx.organizationId,
        provider: "openai",
        modelId: "gpt-5.4-both",
      });
      expect(
        (await choose({ llmApiKeyId: both.key.id, modelId: both.model.id }))
          .statusCode,
      ).toBe(200);
      await LlmProviderApiKeyModel.delete(both.key.id);
      await ModelModel.deleteOrphanedModels();
      expect(await storedChoice(agent.id, member.id)).toMatchObject({
        llmApiKeyId: null,
        modelId: null,
      });
      await stale("The connection you chose no longer exists.");

      // A model deleted while its connection stays is not replaced by the
      // connection's default.
      const kept = await makeKeyWithModel({
        organizationId: ctx.organizationId,
        provider: "openai",
        modelId: "gpt-5.4-kept",
      });
      expect(
        (await choose({ llmApiKeyId: kept.key.id, modelId: kept.model.id }))
          .statusCode,
      ).toBe(200);
      await LlmProviderApiKeyModelLinkModel.deleteLinksForApiKey(kept.key.id);
      await ModelModel.deleteOrphanedModels();
      expect(await storedChoice(agent.id, member.id)).toMatchObject({
        llmApiKeyId: kept.key.id,
        modelId: null,
      });
      await stale("The model you chose no longer exists.");

      // Choosing again is what fixes it.
      const again = await choose({
        llmApiKeyId: fallback.key.id,
        modelId: fallback.model.id,
      });
      expect(again.statusCode, again.body).toBe(200);
      expect(await as(member, () => preflight())).toMatchObject({
        accountError: null,
      });
    });
  });

  test("refuses a personal subscription where the runtime has none, whatever its model's provider", async ({
    makeAgent,
  }) => {
    // The caller's own ChatGPT and SuperGrok are connected, with a model
    // each: the runtime decides, so neither can be chosen.
    const chatGpt = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4-own",
      userId: ctx.user.id,
      apiKeyValue: "chatgpt-oauth:example-subscription",
    });
    const superGrok = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "xai",
      modelId: "grok-4.3-own",
      userId: ctx.user.id,
      apiKeyValue: "xai-subscription:example-subscription",
    });
    const cases = [
      {
        provider: "openai",
        modelId: "gpt-5.4",
        command: ["archestra-opencode"],
        ownModelId: chatGpt.model.id,
      },
      {
        provider: "xai",
        modelId: "grok-4.3",
        command: ["archestra-opencode"],
        ownModelId: superGrok.model.id,
      },
      // A custom image that does not declare Claude Code.
      {
        provider: "openai",
        modelId: "gpt-5.4",
        command: null,
        ownModelId: chatGpt.model.id,
      },
    ] as const;
    for (const { provider, modelId, command, ownModelId } of cases) {
      const { key, model } = await makeKeyWithModel({
        organizationId: ctx.organizationId,
        provider,
        modelId,
      });
      const target = await makeAgent({
        organizationId: ctx.organizationId,
        authorId: ctx.user.id,
        agentType: "agent",
        llmApiKeyId: key.id,
        modelId: model.id,
        runtime: runtimeFor({
          inferenceProtocol: "openai_chat",
          command: command && [...command],
        }),
      });
      const label = `${provider} on ${command?.[0] ?? "no command"}`;

      for (const payload of [
        { authentication: "subscription" },
        ...(ownModelId
          ? [{ authentication: "subscription", modelId: ownModelId }]
          : []),
      ]) {
        const refused = await put(payload, target.id);
        expect(refused.statusCode, label).toBe(400);
        expect(refused.json().error.message, label).toBe(
          "This agent's runtime cannot run on a personal subscription. Choose the company API key instead.",
        );
      }
      expect(await storedChoice(target.id), label).toBeNull();
      // Its company key stays theirs to choose.
      const company = await put({ authentication: "provider" }, target.id);
      expect(company.statusCode, `${label}: ${company.body}`).toBe(200);
    }
  });

  test("saves a Claude subscription", async ({ makeAgent }) => {
    const claude = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      runtime: runtimeFor({
        inferenceProtocol: "anthropic",
        command: ["archestra-claude-code"],
      }),
    });

    const saved = await put({ authentication: "subscription" }, claude.id);

    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({
      companyKey: false,
      choice: { authentication: "subscription", modelId: null },
      choiceError: null,
      subscription: { kind: "claude", connected: false },
    });
  });

  test("saves the model a person picks for their own Claude subscription, and only there", async ({
    makeAgent,
  }) => {
    const claude = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      runtime: runtimeFor({
        inferenceProtocol: "anthropic",
        command: ["archestra-claude-code"],
      }),
    });

    const saved = await put(
      { authentication: "subscription", claudeModel: "sonnet" },
      claude.id,
    );
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().choice).toEqual({
      authentication: "subscription",
      llmApiKeyId: null,
      modelId: null,
      claudeModel: "sonnet",
    });
    // Choosing the subscription again without a model goes back to the
    // agent's model.
    const cleared = await put({ authentication: "subscription" }, claude.id);
    expect(cleared.json().choice).toMatchObject({ claudeModel: null });

    // Not with the company key, and not with a subscription that is not
    // Claude's: the maintained Codex runtime runs on ChatGPT.
    const codex = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      runtime: runtimeFor({
        inferenceProtocol: "openai_responses",
        command: ["archestra-codex"],
      }),
    });
    await giveCompanyKey(codex.id);
    for (const payload of [
      { authentication: "provider", claudeModel: "sonnet" },
      { authentication: "subscription", claudeModel: "sonnet" },
    ]) {
      const refused = await put(payload, codex.id);
      expect(refused.statusCode, refused.body).toBe(400);
      expect(refused.json().error.message).toBe(
        "A Claude subscription model goes only with your own Claude subscription. Leave it empty.",
      );
    }
    expect(await storedChoice(codex.id)).toBeNull();
  });

  test("saves the model of a personal subscription that is not Claude's", async ({
    makeAgent,
  }) => {
    const own = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4",
    });
    const chatGpt = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4-own",
      userId: ctx.user.id,
      apiKeyValue: "chatgpt-oauth:example-subscription",
    });
    const codex = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      llmApiKeyId: own.key.id,
      modelId: own.model.id,
      runtime: runtimeFor({
        inferenceProtocol: "openai_responses",
        command: ["archestra-codex"],
      }),
    });

    const saved = await put(
      { authentication: "subscription", modelId: chatGpt.model.id },
      codex.id,
    );

    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({
      choice: { authentication: "subscription", modelId: chatGpt.model.id },
      choiceError: null,
      subscription: {
        kind: "chatgpt",
        connected: true,
        keyId: chatGpt.key.id,
      },
    });

    // Once the model is deleted, their runs wait for them to choose again
    // instead of taking the subscription's default model.
    await LlmProviderApiKeyModelLinkModel.deleteLinksForApiKey(chatGpt.key.id);
    await ModelModel.deleteOrphanedModels();
    expect(await read(codex.id)).toMatchObject({
      choice: { authentication: "subscription", modelId: null },
      choiceError:
        "Your own account for this agent no longer works. Its model no longer exists. Choose your account again.",
    });
  });

  test("refuses a model of another vendor's subscription, and sets a subscription choice aside once the runtime has none", async ({
    makeAgent,
  }) => {
    const own = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4",
    });
    const superGrok = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "xai",
      modelId: "grok-4.3-own",
      userId: ctx.user.id,
      apiKeyValue: "xai-subscription:example-subscription",
    });
    const codex = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      llmApiKeyId: own.key.id,
      modelId: own.model.id,
      runtime: runtimeFor({
        inferenceProtocol: "openai_responses",
        command: ["archestra-codex"],
      }),
    });

    // Codex runs on ChatGPT: a SuperGrok model is not one of its.
    const wrongVendor = await put(
      { authentication: "subscription", modelId: superGrok.model.id },
      codex.id,
    );
    expect(wrongVendor.statusCode, wrongVendor.body).toBe(400);
    expect(wrongVendor.json().error.message).toBe(
      "grok-4.3-own cannot run on a personal subscription here. Choose one of your subscription's models.",
    );

    // A choice made on Codex stops applying once the agent moves to a
    // runtime with no subscription of its own.
    expect(
      (await put({ authentication: "subscription" }, codex.id)).statusCode,
    ).toBe(200);
    await AgentModel.update(codex.id, {
      runtime: runtimeFor({
        inferenceProtocol: "openai_chat",
        command: ["archestra-opencode"],
      }),
    });
    const read = await app.inject({
      method: "GET",
      url: `/api/agents/${codex.id}/runtime/account`,
    });
    expect(read.json()).toMatchObject({
      subscription: null,
      choice: { authentication: "subscription" },
      choiceError:
        "Your own account for this agent no longer works. Its runtime does not run on personal subscriptions. Choose your account again.",
    });
  });

  test("refuses a model with a Claude subscription, the subscription off the Anthropic protocol, and on a custom image", async ({
    makeAgent,
  }) => {
    const claude = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      runtime: runtimeFor({
        inferenceProtocol: "anthropic",
        command: ["archestra-claude-code"],
      }),
    });
    const offProtocol = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      runtime: runtimeFor({
        inferenceProtocol: "openai_chat",
        command: ["archestra-claude-code"],
      }),
    });
    // Only the maintained Claude Code runtime runs on a Claude subscription,
    // whatever Claude account a custom image stores.
    const custom = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      runtime: runtimeFor({
        inferenceProtocol: "anthropic",
        command: ["my-claude-agent"],
        claudeCode: { authentication: "subscription" },
      }),
    });
    const { model } = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });

    const withModel = await put(
      { authentication: "subscription", modelId: model.id },
      claude.id,
    );
    const wrongProtocol = await put(
      { authentication: "subscription" },
      offProtocol.id,
    );
    const onCustom = await put({ authentication: "subscription" }, custom.id);

    expect(withModel.statusCode).toBe(400);
    expect(withModel.json().error.message).toBe(
      "A Claude subscription names its model as Claude Code does. Leave the catalog model empty.",
    );
    expect(wrongProtocol.statusCode).toBe(409);
    expect(wrongProtocol.json().error.message).toBe(
      "A Claude subscription needs an image that uses the Anthropic API inference protocol.",
    );
    expect(onCustom.statusCode).toBe(400);
    expect(onCustom.json().error.message).toBe(
      "This agent's runtime cannot run on a personal subscription. Choose the company API key instead.",
    );
    for (const agentId of [claude.id, offProtocol.id, custom.id]) {
      expect(
        await AgentRuntimeUserAccountModel.find({
          agentId,
          userId: ctx.user.id,
        }),
      ).toBeNull();
    }
  });

  test("refuses a kind the agent's lock forbids", async ({ makeAgent }) => {
    const own = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
    const lockedTo = (accountLock: "subscription" | "key") =>
      makeAgent({
        organizationId: ctx.organizationId,
        authorId: ctx.user.id,
        agentType: "agent",
        llmApiKeyId: accountLock === "subscription" ? null : own.key.id,
        modelId: accountLock === "subscription" ? null : own.model.id,
        runtime: runtimeFor({
          inferenceProtocol: "anthropic",
          command: ["archestra-claude-code"],
          claudeCode: {
            authentication:
              accountLock === "subscription" ? "subscription" : "provider",
          },
          accountLock,
        }),
      });
    const company = { authentication: "provider" };
    const subscription = { authentication: "subscription" };

    const bySubscription = await lockedTo("subscription");
    const byKey = await lockedTo("key");

    const refused = await put(company, bySubscription.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toBe(
      "This agent is locked to each person's own subscription, so you cannot choose a company API key for it.",
    );
    expect((await put(subscription, bySubscription.id)).statusCode).toBe(200);

    const refusedByKey = await put(subscription, byKey.id);
    expect(refusedByKey.statusCode).toBe(409);
    expect(refusedByKey.json().error.message).toBe(
      "This agent is locked to a company API key, so you cannot choose a personal subscription for it.",
    );
    expect(await storedChoice(byKey.id)).toBeNull();
    // The agent's company key is what a key lock gives everyone anyway.
    const allowed = await put(company, byKey.id);
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(allowed.json()).toMatchObject({
      lock: "key",
      choice: { authentication: "provider", modelId: null },
      choiceError: null,
    });
  });

  test("keeps the choice when the agent's key goes and removes it with its agent", async ({
    makeAgent,
  }) => {
    const own = await giveCompanyKey();
    const other = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "agent",
      runtime: runtimeFor({ inferenceProtocol: "openai_responses" }),
    });
    const remaining = await giveCompanyKey(other.id);
    const payload = { authentication: "provider" };
    expect((await put(payload)).statusCode).toBe(200);
    expect((await put(payload, other.id)).statusCode).toBe(200);

    await LlmProviderApiKeyModel.delete(own.key.id);
    await AgentModel.hardDelete(other.id);

    // The row stays. The agent sets no connection any more, and the person
    // never picked one: their runs are on the organization's default.
    expect(await storedChoice()).toMatchObject({ authentication: "provider" });
    expect(await read()).toMatchObject({
      companyKey: true,
      companyAccount: {
        connection: { id: remaining.key.id, fixedBy: null },
        usesOrganizationDefault: true,
      },
      choice: { authentication: "provider", modelId: null },
      choiceError: null,
    });
    expect(await storedChoice(other.id)).toBeNull();
  });

  test("audits a change with the ids it names, and skips a write that changes nothing", async () => {
    const own = await makeKeyWithModel({
      organizationId: ctx.organizationId,
      provider: "openai",
      modelId: "gpt-5.4",
    });
    const payload = { authentication: "provider" };
    const withConnection = {
      authentication: "provider",
      llmApiKeyId: own.key.id,
      modelId: own.model.id,
    };

    expect((await put(payload)).statusCode).toBe(200);
    expect((await put(payload)).statusCode).toBe(200);
    expect((await put(withConnection)).statusCode).toBe(200);
    expect((await put(withConnection)).statusCode).toBe(200);
    await drainBackgroundWork();

    const unset = {
      authentication: "provider",
      llmApiKeyId: null,
      modelId: null,
      claudeModel: null,
    };
    const audits = await accountAudits(agent.id);
    expect(audits).toHaveLength(2);
    expect(audits).toEqual(
      expect.arrayContaining([
        {
          action: "agent.updated",
          actorId: ctx.user.id,
          httpMethod: "PUT",
          before: { runtimeAccountChoice: null },
          after: { runtimeAccountChoice: unset },
        },
        {
          action: "agent.updated",
          actorId: ctx.user.id,
          httpMethod: "PUT",
          before: { runtimeAccountChoice: unset },
          after: {
            runtimeAccountChoice: {
              ...unset,
              llmApiKeyId: own.key.id,
              modelId: own.model.id,
            },
          },
        },
      ]),
    );
    // Ids and the kind, and nothing of the connection itself.
    expect(JSON.stringify(audits)).not.toContain("sk-test-company-key");
  });
});
