import { eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  onTestFinished,
  test,
} from "@/test";
import {
  autoRouterId,
  configureAutoRouter,
  configureAutoRouting,
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

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    currentUser = await makeUser();
    organizationId = (await makeOrganization()).id;
    await makeMember(currentUser.id, organizationId, { role: "admin" });
    const enabled = config.autoRouting.enabled;
    config.autoRouting.enabled = true;
    onTestFinished(() => {
      config.autoRouting.enabled = enabled;
    });
    tiers = await configureAutoRouting(organizationId);
    routerId = await autoRouterId(organizationId);
    const key = await LlmProviderApiKeyModel.findOrganizationWideKey(
      organizationId,
      "openai",
    );
    if (!key) throw new Error("tier key missing");
    tierKeyId = key.id;

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
