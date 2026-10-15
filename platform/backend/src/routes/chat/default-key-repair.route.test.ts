import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import MemberModel from "@/models/member";
import ModelModel from "@/models/model";
import OrganizationModel from "@/models/organization";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

/**
 * The organization and member defaults name a key someone chose. A member who
 * may not use that key never runs through it — the send path falls back to a
 * key they may use — so the conversation must store that key, not the one in
 * the default. Saving a member default needs a key the member may use.
 */
describe("member and organization default keys the member cannot use", () => {
  let app: FastifyInstanceWithZod;
  let member: User;
  let organizationId: string;
  let modelId: string;
  let usableKeyId: string;
  let readOnlyKeyId: string;
  let adminOnlyKeyId: string;
  let agentId: string;

  beforeEach(
    async ({
      makeAgent,
      makeLlmProviderApiKey,
      makeMember,
      makeOrganization,
      makeSecret,
      makeUser,
    }) => {
      organizationId = (await makeOrganization()).id;
      member = await makeUser();
      await makeMember(member.id, organizationId, { role: "member" });

      const secret = await makeSecret({ secret: { apiKey: "synthetic-key" } });
      const [usable, readOnly, adminOnly] = await Promise.all(
        [
          { name: "usable", access: { users: [member.id], preset: "use" } },
          { name: "read-only", access: { users: [member.id], preset: "view" } },
          { name: "admin-only", access: { users: [] } },
        ].map(({ name, access }) =>
          makeLlmProviderApiKey(organizationId, secret.id, {
            name,
            provider: "openai",
            access: access as { users: string[]; preset?: "use" | "view" },
          }),
        ),
      );
      usableKeyId = usable.id;
      readOnlyKeyId = readOnly.id;
      adminOnlyKeyId = adminOnly.id;

      const model = await ModelModel.create({
        externalId: "openai/default-repair-model",
        provider: "openai",
        modelId: "default-repair-model",
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        lastSyncedAt: new Date(),
      });
      modelId = model.id;
      await Promise.all(
        [usable, readOnly, adminOnly].map((key) =>
          LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
            model.id,
          ]),
        ),
      );
      agentId = (await makeAgent({ organizationId, agentType: "agent" })).id;

      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        (request as typeof request & { user: User }).user = member;
        (
          request as typeof request & { organizationId: string }
        ).organizationId = organizationId;
      });
      const [{ default: chatRoutes }, { default: agentRoutes }] =
        await Promise.all([import("./routes"), import("../agent")]);
      await app.register(chatRoutes);
      await app.register(agentRoutes);
    },
  );

  afterEach(async () => {
    await app.close();
  });

  const startChat = () =>
    app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      payload: { agentId },
    });

  test("stores the org default model with a key the member may use", async () => {
    await OrganizationModel.patch(organizationId, {
      defaultModelId: modelId,
      defaultLlmApiKeyId: adminOnlyKeyId,
    });

    const response = await startChat();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      modelId,
      chatApiKeyId: usableKeyId,
    });
  });

  test("re-pairs a saved member default whose key became read-only", async () => {
    await MemberModel.setDefaultModelSelection({
      userId: member.id,
      organizationId,
      modelId,
      apiKeyId: readOnlyKeyId,
    });

    const response = await startChat();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      modelId,
      chatApiKeyId: usableKeyId,
    });
  });

  test("refuses to save a member default with a key the member cannot use", async () => {
    const refused = await app.inject({
      method: "PUT",
      url: "/api/members/default-model",
      payload: { modelId, chatApiKeyId: readOnlyKeyId },
    });
    expect(refused.statusCode).toBe(403);

    const saved = await app.inject({
      method: "PUT",
      url: "/api/members/default-model",
      payload: { modelId, chatApiKeyId: usableKeyId },
    });
    expect(saved.statusCode).toBe(200);
  });
});
