import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
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

vi.mock("@/auth");

import { userHasPermission } from "@/auth";

const mockUserHasPermission = vi.mocked(userHasPermission);

describe("GET /api/llm-virtual-keys/:id/value", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    const organization = await makeOrganization({ legacyPermissions: true });
    organizationId = organization.id;
    user = await makeUser();
    await makeMember(user.id, organizationId);
    mockUserHasPermission.mockReset();
    mockUserHasPermission.mockResolvedValue(false);

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
