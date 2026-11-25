import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  autoRouterId,
  configureAutoRouter,
  configureAutoRouting,
  makeRoutingModel,
  setAutoRoutingTiers,
} from "@/test/auto-routing";
import type { User } from "@/types";

/**
 * A conversation on an auto router stores the normal tier's model and key; picking a
 * key, a model, a pool (or none) or another agent leaves the router.
 */
describe("chat conversation routes - auto router", () => {
  let app: FastifyInstanceWithZod;
  let currentUser: User;
  let organizationId: string;
  let tiers: Awaited<ReturnType<typeof configureAutoRouting>>;
  let tierKeyId: string;
  let routerId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember, makeSecret }) => {
    currentUser = await makeUser();
    organizationId = (await makeOrganization()).id;
    await makeMember(currentUser.id, organizationId, { role: "admin" });
    tiers = await configureAutoRouting(organizationId);
    routerId = await autoRouterId(organizationId);
    const key = await LlmProviderApiKeyModel.findOrganizationWideKey(
      organizationId,
      "openai",
    );
    if (!key) throw new Error("tier key missing");
    tierKeyId = key.id;
    const secret = await makeSecret({
      secret: { apiKey: "synthetic-tier-key" },
    });
    await LlmProviderApiKeyModel.update(tierKeyId, { secretId: secret.id });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user: currentUser, organizationId });
    });
    const { default: chatRoutes } = await import("./routes");
    await app.register(chatRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  const createConversation = (payload: object) =>
    app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      payload,
    });
  const patch = (id: string, payload: object) =>
    app.inject({
      method: "PATCH",
      url: `/api/chat/conversations/${id}`,
      payload,
    });

  test("a chat on an agent following an auto organization default starts on auto, on the normal tier", async ({
    makeAgent,
  }) => {
    await db
      .update(schema.organizationsTable)
      .set({ defaultAutoRouterId: routerId })
      .where(eq(schema.organizationsTable.id, organizationId));
    const agent = await makeAgent({ organizationId, authorId: currentUser.id });

    const response = await createConversation({ agentId: agent.id });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      autoRouterId: routerId,
      modelId: tiers[1].id,
      chatApiKeyId: tierKeyId,
    });
  });

  test("a restricted member sees an actionable denial for inherited and explicit Auto", async ({
    makeAgent,
    makeUser,
    makeMember,
    makeCustomRole,
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    const owner = currentUser;
    // The router's older organization-visible key grants use to the
    // roles that existed when the key was created.
    await db
      .update(schema.organizationsTable)
      .set({ defaultAutoRouterId: routerId })
      .where(eq(schema.organizationsTable.id, organizationId));
    const agent = await makeAgent({ organizationId, authorId: owner.id });
    currentUser = await makeUser();
    const role = await makeCustomRole(organizationId, {
      permission: { agent: ["read"] },
    });
    await makeMember(currentUser.id, organizationId, { role: role.role });

    const inherited = await createConversation({ agentId: agent.id });
    expect(inherited.statusCode, inherited.body).toBe(403);
    expect(inherited.json().error.message).toContain(
      "Auto's normal model or connection",
    );

    const alternate = await makeLlmProviderApiKey(
      organizationId,
      (await makeSecret({ secret: { apiKey: "synthetic-alternate-key" } })).id,
      {
        provider: "openai",
        access: { users: [currentUser.id], preset: "use" },
      },
    );
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(alternate.id, [
      tiers[0].id,
    ]);
    const explicit = await createConversation({
      agentId: agent.id,
      modelId: tiers[0].id,
      chatApiKeyId: alternate.id,
      strictModelSelection: true,
    });
    expect(explicit.statusCode, explicit.body).toBe(200);
    expect(explicit.json()).toMatchObject({
      autoRouterId: null,
      modelId: tiers[0].id,
    });
    const switched = await patch(explicit.json().id, {
      autoRouterId: routerId,
    });
    expect(switched.statusCode, switched.body).toBe(403);
  });

  test("rejects an unlinked explicit choice for the updated composer without changing legacy fallback", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ organizationId, authorId: currentUser.id });
    const stale = await makeRoutingModel();
    const selection = {
      agentId: agent.id,
      modelId: stale.id,
      chatApiKeyId: tierKeyId,
    };
    const rejected = await createConversation({
      ...selection,
      strictModelSelection: true,
    });
    expect(rejected.statusCode, rejected.body).toBe(409);
    expect(rejected.json().error.message).toContain("Choose a model again");
    const legacy = await createConversation(selection);
    expect(legacy.statusCode, legacy.body).toBe(200);
    expect(legacy.json().modelId).not.toBe(stale.id);
    const rejectedUpdate = await patch(legacy.json().id, {
      modelId: stale.id,
      strictModelSelection: true,
    });
    expect(rejectedUpdate.statusCode, rejectedUpdate.body).toBe(409);
  });

  test("keeps the normal tier usable when chat cannot route to a sibling tier", async ({
    makeAgent,
    makeSecret,
  }) => {
    const normal = await ModelModel.create({
      externalId: "bedrock/test-normal",
      provider: "bedrock",
      modelId: "test-normal",
      inputModalities: ["text"],
      outputModalities: ["text"],
    });
    await setAutoRoutingTiers(organizationId, { normal });
    const key = await LlmProviderApiKeyModel.findOrganizationWideKey(
      organizationId,
      "bedrock",
    );
    if (!key) throw new Error("missing normal key");
    const secret = await makeSecret({
      secret: { apiKey: "synthetic-normal-key" },
    });
    await LlmProviderApiKeyModel.update(key.id, { secretId: secret.id });
    const agent = await makeAgent({ organizationId, authorId: currentUser.id });

    const created = await createConversation({
      agentId: agent.id,
      autoRouterId: routerId,
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json()).toMatchObject({
      autoRouterId: routerId,
      modelId: normal.id,
      chatApiKeyId: key.id,
    });
  });

  test("an inherited router without its normal tier reports the configuration error", async ({
    makeAgent,
  }) => {
    await setAutoRoutingTiers(organizationId, { normal: null });
    await db
      .update(schema.organizationsTable)
      .set({ defaultAutoRouterId: routerId })
      .where(eq(schema.organizationsTable.id, organizationId));
    const agent = await makeAgent({ organizationId, authorId: currentUser.id });
    const created = await createConversation({ agentId: agent.id });
    expect(created.statusCode, created.body).toBe(400);
    expect(created.json().error.message).toContain("auto router is not set up");
  });

  test("an explicit personal model pick overrides the agent's Copilot App even on the same model", async ({
    makeAgent,
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    const personal = await ModelModel.create({
      externalId: "github-copilot/test-personal",
      provider: "github-copilot",
      modelId: "test-personal",
      inputModalities: ["text"],
      outputModalities: ["text"],
    });
    const appKey = await makeLlmProviderApiKey(
      organizationId,
      (await makeSecret({ secret: { apiKey: "github-app:synthetic" } })).id,
      { provider: "github-copilot" },
    );
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(appKey.id, [
      personal.id,
    ]);
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      modelId: personal.id,
      llmApiKeyId: appKey.id,
    });
    const created = await createConversation({ agentId: agent.id });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json().chatApiKeyId).toBe(appKey.id);
    const selected = await patch(created.json().id, {
      modelId: personal.id,
      chatApiKeyId: null,
      strictModelSelection: true,
    });
    expect(selected.statusCode, selected.body).toBe(200);
    expect(selected.json()).toMatchObject({
      modelId: personal.id,
      chatApiKeyId: null,
      autoRouterId: null,
    });
    expect(
      await LlmProviderApiKeyModel.getCurrentApiKey({
        organizationId,
        userId: currentUser.id,
        userTeamIds: [],
        provider: "github-copilot",
        conversationId: created.json().id,
        agentLlmApiKeyId: appKey.id,
      }),
    ).toBeNull();
  });

  test("a chat on a second router starts on that router's normal tier", async ({
    makeAgent,
  }) => {
    const { router, trio } = await configureAutoRouter(
      organizationId,
      "auto:second",
    );
    const agent = await makeAgent({ organizationId, authorId: currentUser.id });

    const response = await createConversation({
      agentId: agent.id,
      autoRouterId: router.id,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      autoRouterId: router.id,
      modelId: trio[1].id,
    });
    expect(response.json().modelId).not.toBe(tiers[1].id);
  });

  test("picking auto, then the key it runs on, leaves auto", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ organizationId, authorId: currentUser.id });
    const created = await createConversation({ agentId: agent.id });
    expect(created.json().autoRouterId).toBeNull();

    const onAuto = await patch(created.json().id, { autoRouterId: routerId });
    expect(onAuto.statusCode, onAuto.body).toBe(200);
    expect(onAuto.json()).toMatchObject({
      autoRouterId: routerId,
      modelId: tiers[1].id,
      chatApiKeyId: tierKeyId,
    });

    // The menu leaves a pool, and auto, by clearing the pool.
    const left = await patch(created.json().id, { modelPoolId: null });
    expect(left.statusCode, left.body).toBe(200);
    expect(left.json()).toMatchObject({
      autoRouterId: null,
      modelPoolId: null,
      chatApiKeyId: tierKeyId,
    });
  });

  test("picking a model, or another agent, leaves auto", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ organizationId, authorId: currentUser.id });
    const other = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      modelId: tiers[2].id,
      llmApiKeyId: tierKeyId,
    });
    const created = await createConversation({
      agentId: agent.id,
      autoRouterId: routerId,
    });
    expect(created.json().autoRouterId).toBe(routerId);

    const pickedModel = await patch(created.json().id, {
      modelId: tiers[0].id,
      chatApiKeyId: tierKeyId,
    });
    expect(pickedModel.json()).toMatchObject({
      autoRouterId: null,
      modelId: tiers[0].id,
    });

    await patch(created.json().id, { autoRouterId: routerId });
    const switched = await patch(created.json().id, { agentId: other.id });
    expect(switched.statusCode, switched.body).toBe(200);
    expect(switched.json()).toMatchObject({
      autoRouterId: null,
      agentId: other.id,
      modelId: tiers[2].id,
    });
  });
});
