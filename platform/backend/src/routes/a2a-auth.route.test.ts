// Route-level auth tests for the A2A endpoints (v1 `/v1/a2a` and v2 `/v2/a2a`)
// exercising the REAL `validateMCPGatewayToken` path — not a mock of it. The
// other A2A tests (a2a.test.ts / a2a-v2.stream.test.ts) stub the validator, so
// real token validation was previously untested.
//
// A2A only authenticates with static Archestra platform tokens (personal /
// team / org). The external-IdP JWT and OAuth methods the validator also
// supports are gated to `mcp_gateway` / `llm_proxy` agents (IdP binding and the
// OAuth "allowed gateways" picker), and A2A serves only `agentType: "agent"`,
// so they are not reachable for A2A agents — hence not covered here.

import { vi } from "vitest";
import { TeamTokenModel, UserTokenModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";

const { mockExecuteA2AMessage } = vi.hoisted(() => ({
  mockExecuteA2AMessage: vi.fn(),
}));

// NOTE: `@/routes/mcp-gateway.utils` is intentionally NOT mocked — the real
// validator runs. Only the LLM run is stubbed so no model is invoked.
vi.mock("@/agents/a2a-executor", () => ({
  executeA2AMessage: (...args: unknown[]) => mockExecuteA2AMessage(...args),
}));

vi.mock("@/observability/tracing", async () => {
  const actual = await vi.importActual<
    typeof import("@/observability/tracing")
  >("@/observability/tracing");
  return {
    ...actual,
    startActiveChatSpan: async <T>(params: {
      callback: () => Promise<T>;
    }): Promise<T> => params.callback(),
  };
});

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

const v2Payload = (text = "hi") => ({
  jsonrpc: "2.0" as const,
  id: 1,
  method: "SendMessage",
  params: {
    message: {
      messageId: crypto.randomUUID(),
      role: "ROLE_USER",
      parts: [{ text }],
    },
  },
});

const v1Payload = (text = "hi") => ({
  jsonrpc: "2.0" as const,
  id: 1,
  method: "message/send",
  params: { message: { parts: [{ kind: "text", text }] } },
});

describe("a2a route-level authentication", () => {
  let app: FastifyInstanceWithZod;

  beforeEach(async () => {
    mockExecuteA2AMessage.mockReset();
    // A successful run: a uuid message id so v2's stateful persistence accepts it.
    mockExecuteA2AMessage.mockImplementation(async () => {
      const messageId = crypto.randomUUID();
      return {
        messageId,
        text: "ok",
        finishReason: "stop",
        responseUiMessage: {
          id: messageId,
          role: "assistant",
          parts: [{ type: "text", text: "ok" }],
        },
      };
    });

    app = createFastifyInstance();
    const { default: a2aRoutes } = await import("./a2a");
    const { default: a2aV2Routes } = await import("./a2a-v2");
    await app.register(a2aRoutes);
    await app.register(a2aV2Routes);
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  // === v2: each static-token scope authenticates and reaches execution ===

  test("v2 SendMessage accepts a static organization token", async ({
    makeOrganization,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeInternalAgent({ organizationId: org.id });
    const { value } = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });

    const res = await app.inject({
      method: "POST",
      url: `/v2/a2a/${agent.id}`,
      headers: bearer(value),
      payload: v2Payload(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().error).toBeUndefined();
    expect(mockExecuteA2AMessage).toHaveBeenCalledTimes(1);
  });

  test("v2 SendMessage accepts a static user token for a member of the agent's org", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeInternalAgent({ organizationId: org.id });
    const { value } = await UserTokenModel.create(user.id, org.id);

    const res = await app.inject({
      method: "POST",
      url: `/v2/a2a/${agent.id}`,
      headers: bearer(value),
      payload: v2Payload(),
    });

    expect(res.json().error).toBeUndefined();
    expect(mockExecuteA2AMessage).toHaveBeenCalledTimes(1);
  });

  test("v2 SendMessage accepts a team token for an agent shared with that team", async ({
    makeOrganization,
    makeUser,
    makeTeam,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id, { name: "Dev Team" });
    const agent = await makeInternalAgent({
      organizationId: org.id,
      teams: [team.id],
      scope: "team",
    });
    const { value } = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Team Token",
      teamId: team.id,
    });

    const res = await app.inject({
      method: "POST",
      url: `/v2/a2a/${agent.id}`,
      headers: bearer(value),
      payload: v2Payload(),
    });

    expect(res.json().error).toBeUndefined();
    expect(mockExecuteA2AMessage).toHaveBeenCalledTimes(1);
  });

  // === v2: rejection cases never reach execution ===

  test("v2 rejects a missing token with a JSON-RPC error and no run", async ({
    makeOrganization,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeInternalAgent({ organizationId: org.id });

    const res = await app.inject({
      method: "POST",
      url: `/v2/a2a/${agent.id}`,
      payload: v2Payload(),
    });

    expect(res.json().error.code).toBe(-32600);
    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
  });

  test("v2 rejects a garbage bearer token with no run", async ({
    makeOrganization,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeInternalAgent({ organizationId: org.id });

    const res = await app.inject({
      method: "POST",
      url: `/v2/a2a/${agent.id}`,
      headers: bearer("not-a-real-token"),
      payload: v2Payload(),
    });

    expect(res.json().error).toBeDefined();
    expect(res.json().result).toBeUndefined();
    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
  });

  // === v1: the same validator authenticates the legacy endpoint ===

  test("v1 accepts a static organization token", async ({
    makeOrganization,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeInternalAgent({ organizationId: org.id });
    const { value } = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/a2a/${agent.id}`,
      headers: bearer(value),
      payload: v1Payload(),
    });

    expect(res.json().result).toBeDefined();
    expect(mockExecuteA2AMessage).toHaveBeenCalledTimes(1);
  });

  test("v1 rejects a garbage bearer token with no run", async ({
    makeOrganization,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeInternalAgent({ organizationId: org.id });

    const res = await app.inject({
      method: "POST",
      url: `/v1/a2a/${agent.id}`,
      headers: bearer("not-a-real-token"),
      payload: v1Payload(),
    });

    expect(res.json().error).toBeDefined();
    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
  });
});
