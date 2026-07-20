import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");

import { userHasPermission } from "@/auth";

const mockUserHasPermission = vi.mocked(userHasPermission);

describe("GET /api/llm-virtual-keys/:id", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
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

  test("returns the virtual key by id with provider key mappings and no token value", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const parentKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
      name: "OpenAI Parent Key",
    });

    const { virtualKey } = await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: parentKey.provider, providerApiKeyId: parentKey.id },
      ],
      name: "My Personal",
      scope: "personal",
      authorId: user.id,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/llm-virtual-keys/${virtualKey.id}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      id: virtualKey.id,
      name: "My Personal",
      scope: "personal",
      authorId: user.id,
      authorName: user.name,
      teams: [],
      providerApiKeys: [
        {
          provider: "openai",
          providerApiKeyId: parentKey.id,
          providerApiKeyName: "OpenAI Parent Key",
        },
      ],
    });
    expect(body.tokenStart).toBeTruthy();
    expect(body.value).toBeUndefined();
  });

  test("returns 404 for an unknown id", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/llm-virtual-keys/${randomUUID()}`,
    });

    expect(response.statusCode).toBe(404);
  });

  test("returns 404 for an id belonging to another organization", async ({
    makeOrganization,
  }) => {
    mockUserHasPermission.mockResolvedValue(true);

    const otherOrg = await makeOrganization();
    const { virtualKey } = await VirtualApiKeyModel.create({
      organizationId: otherOrg.id,
      name: "Other Org Key",
      scope: "org",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/llm-virtual-keys/${virtualKey.id}`,
    });

    expect(response.statusCode).toBe(404);
  });

  test("returns 404 for another user's personal key when not an admin", async ({
    makeUser,
  }) => {
    const outsider = await makeUser();
    const { virtualKey } = await VirtualApiKeyModel.create({
      organizationId,
      name: "Other Personal",
      scope: "personal",
      authorId: outsider.id,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/llm-virtual-keys/${virtualKey.id}`,
    });

    expect(response.statusCode).toBe(404);
  });
});
