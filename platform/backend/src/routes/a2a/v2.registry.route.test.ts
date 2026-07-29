import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";

const { mockValidateMCPGatewayToken, mockResolveTokenOrganizationId } =
  vi.hoisted(() => ({
    mockValidateMCPGatewayToken: vi.fn(),
    mockResolveTokenOrganizationId: vi.fn(),
  }));

vi.mock("@/routes/mcp-gateway/utils", async () => {
  const actual = await vi.importActual<
    typeof import("@/routes/mcp-gateway/utils")
  >("@/routes/mcp-gateway/utils");
  return {
    ...actual,
    validateMCPGatewayToken: (...args: unknown[]) =>
      mockValidateMCPGatewayToken(...args),
    resolveTokenOrganizationId: (...args: unknown[]) =>
      mockResolveTokenOrganizationId(...args),
  };
});

describe("a2a v2 agent registry", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let reachableId: string;
  let unreachableId: string;

  beforeEach(async ({ makeInternalAgent, makeUser, makeMember }) => {
    const reachable = await makeInternalAgent({ name: "Reachable Agent" });
    organizationId = reachable.organizationId;
    reachableId = reachable.id;

    // A second agent in the same organization that this credential may not
    // use — the case the registry must not leak.
    const unreachable = await makeInternalAgent({
      name: "Off Limits Agent",
      organizationId,
    });
    unreachableId = unreachable.id;

    const user = await makeUser();
    await makeMember(user.id, organizationId);

    mockResolveTokenOrganizationId.mockResolvedValue(organizationId);
    mockValidateMCPGatewayToken.mockImplementation(async (agentId: string) =>
      agentId === reachableId ? { organizationId, userId: user.id } : null,
    );

    app = createFastifyInstance();
    const { default: a2aV2Routes } = await import("./v2");
    await app.register(a2aV2Routes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    mockValidateMCPGatewayToken.mockReset();
    mockResolveTokenOrganizationId.mockReset();
    await app.close();
  });

  const listAgents = (headers: Record<string, string> = {}) =>
    app.inject({
      method: "GET",
      url: "/v2/a2a/agents",
      headers: { authorization: "Bearer test-token", ...headers },
    });

  test("returns only the agents this credential may reach", async () => {
    const body = (await listAgents()).json();

    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].name).toBe("Reachable Agent");

    // The whole point of the endpoint: an agent the caller cannot use must not
    // be disclosed, by name or by id.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("Off Limits Agent");
    expect(serialized).not.toContain(unreachableId);
  });

  test("authorizes every candidate individually", async () => {
    await listAgents();

    // Both agents are checked; neither is assumed reachable because it shares
    // an organization with the token.
    const checked = mockValidateMCPGatewayToken.mock.calls.map(
      ([agentId]) => agentId,
    );
    expect(checked).toContain(reachableId);
    expect(checked).toContain(unreachableId);
  });

  test("each entry is a usable card pointing at its own endpoint", async () => {
    const card = (await listAgents()).json().agents[0];

    // A client should be able to hand this straight to an A2A library.
    expect(card.supportedInterfaces[0].url).toContain(reachableId);
    expect(card.supportedInterfaces[0].protocolVersion).toBe("1.0");
    expect(card.capabilities.streaming).toBe(true);
    expect(Object.keys(card.securitySchemes).length).toBeGreaterThan(0);
    expect(card.skills[0].tags.length).toBeGreaterThan(0);
    expect(card.provider.organization).toEqual(expect.any(String));
  });

  test("requires a credential and says how to present one", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v2/a2a/agents",
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toContain("Bearer");
    // Nothing about the deployment leaks before authentication.
    expect(response.body).not.toContain("Reachable Agent");
  });

  test("rejects a credential that only has meaning against a named agent", async () => {
    // An IdP JWT or OAuth token is validated per agent, so it has no
    // agent-independent identity to enumerate from.
    mockResolveTokenOrganizationId.mockResolvedValue(null);

    const response = await listAgents();

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toContain("invalid_token");
    // It must not silently degrade to an empty list, which would read as
    // "you have access to nothing" rather than "use a different credential".
    expect(response.body).not.toContain('"agents"');
  });

  test("returns an empty list when the credential reaches nothing", async () => {
    mockValidateMCPGatewayToken.mockResolvedValue(null);

    const response = await listAgents();

    expect(response.statusCode).toBe(200);
    expect(response.json().agents).toEqual([]);
  });

  test("never caches one principal's list for another", async () => {
    const response = await listAgents();

    expect(response.headers["cache-control"]).toContain("private");
  });
});
