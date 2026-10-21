import { randomUUID } from "node:crypto";
import { authPlugin } from "@/auth/fastify-plugin";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import ServiceAccountModel from "@/models/service-account";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import {
  accessGrants,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "@/test";
import type { User } from "@/types";

describe("GET /api/llm-virtual-keys/:id/value", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    const organization = await makeOrganization({ legacyPermissions: true });
    organizationId = organization.id;
    user = await makeUser();
    await makeMember(user.id, organizationId);

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & {
          organizationId: string;
          user: User;
        }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });

    const { default: virtualApiKeysRoutes } = await import(
      "./virtual-api-key.routes"
    );
    await app.register(virtualApiKeysRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("returns the raw value for the key's author", async () => {
    const { virtualKey, value } = await VirtualApiKeyModel.create({
      organizationId,
      name: "My passthrough",
      keyType: "passthrough",
      authorId: user.id,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/llm-virtual-keys/${virtualKey.id}/value`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ value });
    expect(value.startsWith(virtualKey.tokenStart)).toBe(true);
  });

  test("403s for a visible key created by someone else", async ({
    makeUser,
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    const author = await makeUser({ email: "author@example.com" });
    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const parentKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
      name: "OpenAI Parent Key",
    });
    const { virtualKey } = await VirtualApiKeyModel.create({
      organizationId,
      name: "Org shared key",
      authorId: author.id,
      providerApiKeys: [
        { provider: parentKey.provider, providerApiKeyId: parentKey.id },
      ],
      ...accessGrants("org"),
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/llm-virtual-keys/${virtualKey.id}/value`,
    });

    expect(response.statusCode).toBe(403);
  });

  test("404s for an unknown key", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/llm-virtual-keys/${randomUUID()}/value`,
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("GET /api/llm-virtual-keys/:id/value with a service-account token", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let providerApiKeyId: string;

  beforeEach(
    async ({ makeOrganization, makeSecret, makeLlmProviderApiKey }) => {
      organizationId = (await makeOrganization()).id;
      const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
      providerApiKeyId = (
        await makeLlmProviderApiKey(organizationId, secret.id, {
          provider: "openai",
          name: "OpenAI Parent Key",
        })
      ).id;

      app = createFastifyInstance();
      await app.register(authPlugin);
      const { default: virtualApiKeysRoutes } = await import(
        "./virtual-api-key.routes"
      );
      await app.register(virtualApiKeysRoutes);
    },
  );

  afterEach(async () => {
    await app.close();
  });

  async function serviceAccountToken(name: string): Promise<string> {
    const account = await ServiceAccountModel.create({
      organizationId,
      name,
      role: "admin",
      createdBy: null,
    });
    const { token } = await ServiceAccountModel.createToken({
      serviceAccountId: account.id,
      organizationId,
      name: "terraform",
    });
    return token;
  }

  async function createKey(authorization: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      headers: { authorization },
      payload: {
        name: "Vended key",
        providerApiKeys: [{ provider: "openai", providerApiKeyId }],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as { id: string; value: string };
  }

  test("reveals a key to the service account that created it", async () => {
    const authorization = await serviceAccountToken("Terraform");
    const created = await createKey(authorization);

    const response = await app.inject({
      method: "GET",
      url: `/api/llm-virtual-keys/${created.id}/value`,
      headers: { authorization },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ value: created.value });
  });

  test("403s for a key another service account created", async () => {
    const creator = await serviceAccountToken("Terraform");
    const other = await serviceAccountToken("Other automation");
    const created = await createKey(creator);

    const response = await app.inject({
      method: "GET",
      url: `/api/llm-virtual-keys/${created.id}/value`,
      headers: { authorization: other },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain(created.value);
  });
});
