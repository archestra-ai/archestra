import { AgentModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("GET /api/llm-proxy", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();

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

    const { default: llmProxyRoutes } = await import("./llm-proxy.routes");
    await app.register(llmProxyRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("returns the LLM Proxy, creating it on first use", async () => {
    const response = await app.inject({ method: "GET", url: "/api/llm-proxy" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.identityProviderId).toBeNull();

    // Stable across calls: the same singleton row every time.
    const second = await app.inject({ method: "GET", url: "/api/llm-proxy" });
    expect(second.json().id).toBe(body.id);

    const proxy = await AgentModel.getOrgLlmProxy(organizationId);
    expect(proxy.id).toBe(body.id);
    expect(proxy.isDefault).toBe(true);
    expect(proxy.scope).toBe("org");
  });

  test("is organization-scoped: another organization gets its own proxy", async ({
    makeOrganization,
  }) => {
    const first = await app.inject({ method: "GET", url: "/api/llm-proxy" });

    const otherOrg = await makeOrganization();
    const otherProxy = await AgentModel.getOrgLlmProxy(otherOrg.id);

    expect(otherProxy.id).not.toBe(first.json().id);
    expect(otherProxy.organizationId).toBe(otherOrg.id);
  });
});
