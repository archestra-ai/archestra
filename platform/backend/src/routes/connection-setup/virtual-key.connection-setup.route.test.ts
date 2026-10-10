import { adminPermissions } from "@archestra/shared/access-control";
import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import SecretModel from "@/models/secret";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import { readVirtualKeyValue } from "@/services/connection-setup";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import { deriveKeyFromSecret, encryptSecretValueWithKey } from "@/utils/crypto";

describe("POST /api/connection-setups/virtual-key", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });

    const { default: connectionSetupRoutes } = await import(
      "./connection-setup.routes"
    );
    await app.register(connectionSetupRoutes);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
  });

  test("an unreadable generated connection key is revoked and regenerated for new setups", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    await makeLlmProviderApiKey(organizationId, (await makeSecret()).id, {
      provider: "openai",
    });
    const provision = () =>
      app.inject({
        method: "POST",
        url: "/api/connection-setups/virtual-key",
        payload: { provider: "openai" },
      });
    const initial = await provision();
    expect(initial.statusCode).toBe(200);
    const key = await VirtualApiKeyModel.findByAuthorScopeName({
      organizationId,
      authorId: user.id,
      scope: "personal",
      name: `Connection setup — ${user.email}`,
    });
    expect(key).not.toBeNull();
    if (!key) throw new Error("Connection key was not created");
    await SecretModel.updateRawSecret(
      key.secretId,
      encryptSecretValueWithKey(
        { token: initial.json().value },
        deriveKeyFromSecret("unavailable-test-key"),
      ),
    );
    // Let the real process-local credential cache expire.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);
    await expect(readVirtualKeyValue(key.id)).rejects.toMatchObject({
      statusCode: 409,
    });
    const recovered = await provision();
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json().value).toMatch(/arch_[0-9a-f]{64}/);
    expect(recovered.json().value).not.toBe(initial.json().value);
    expect(await VirtualApiKeyModel.findById(key.id)).toBeNull();
  });

  test("provisions a virtual key and returns its value once", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    await makeLlmProviderApiKey(organizationId, (await makeSecret()).id, {
      provider: "anthropic",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/connection-setups/virtual-key",
      payload: { provider: "anthropic" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.value).toMatch(/arch_[0-9a-f]{64}/);
    expect(body.name).toContain("Connection setup");
  });

  test("403s without llmVirtualKey:create permission", async ({
    makeSecret,
    makeLlmProviderApiKey,
    makeCustomRole,
    makeMember,
    makeUser,
  }) => {
    const role = await makeCustomRole(organizationId, {
      permission: Object.fromEntries(
        Object.entries(adminPermissions).map(([resource, actions]) => [
          resource,
          resource === "llmVirtualKey"
            ? actions.filter((action) => action !== "create")
            : actions,
        ]),
      ),
    });
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: role.role });
    await makeLlmProviderApiKey(organizationId, (await makeSecret()).id, {
      provider: "anthropic",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/connection-setups/virtual-key",
      payload: { provider: "anthropic" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain("llmVirtualKey:create");
  });

  test("400s when the caller has no provider key to wrap", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/connection-setups/virtual-key",
      payload: { provider: "anthropic" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("anthropic");
  });

  test("403s when the org has disabled connecting the LLM Proxy", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    await makeLlmProviderApiKey(organizationId, (await makeSecret()).id, {
      provider: "anthropic",
    });
    const { OrganizationModel } = await import("@/models");
    await OrganizationModel.patch(organizationId, {
      connectionLlmProxyEnabled: false,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/connection-setups/virtual-key",
      payload: { provider: "anthropic" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain("LLM Proxy");
  });
});
