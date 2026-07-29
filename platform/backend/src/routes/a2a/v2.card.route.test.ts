import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";

const { mockValidateMCPGatewayToken } = vi.hoisted(() => ({
  mockValidateMCPGatewayToken: vi.fn(),
}));

vi.mock("@/routes/mcp-gateway/utils", async () => {
  const actual = await vi.importActual<
    typeof import("@/routes/mcp-gateway/utils")
  >("@/routes/mcp-gateway/utils");
  return {
    ...actual,
    validateMCPGatewayToken: (...args: unknown[]) =>
      mockValidateMCPGatewayToken(...args),
  };
});

describe("a2a v2 AgentCard conformance", () => {
  let app: FastifyInstanceWithZod;
  let agentId: string;
  let cardUrl: string;

  beforeEach(async ({ makeInternalAgent, makeUser, makeMember }) => {
    const agent = await makeInternalAgent();
    const user = await makeUser();
    await makeMember(user.id, agent.organizationId);
    agentId = agent.id;
    cardUrl = `/v2/a2a/${agentId}/.well-known/agent-card.json`;

    mockValidateMCPGatewayToken.mockResolvedValue({
      organizationId: agent.organizationId,
      userId: user.id,
    });

    app = createFastifyInstance();
    const { default: a2aV2Routes } = await import("./v2");
    await app.register(a2aV2Routes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    mockValidateMCPGatewayToken.mockReset();
    await app.close();
  });

  const fetchCard = (headers: Record<string, string> = {}) =>
    app.inject({
      method: "GET",
      url: cardUrl,
      headers: { authorization: "Bearer test-token", ...headers },
    });

  test("declares how to authenticate", async () => {
    const card = (await fetchCard()).json();

    // Without securitySchemes a client cannot discover how to authenticate.
    expect(Object.keys(card.securitySchemes)).toEqual(
      expect.arrayContaining([
        "platformToken",
        "identityProviderJwt",
        "oauthAccessToken",
      ]),
    );
    for (const scheme of Object.values(card.securitySchemes) as {
      type: string;
      scheme: string;
    }[]) {
      expect(scheme).toMatchObject({ type: "http", scheme: "bearer" });
    }

    // Each scheme is its own alternative — any one of them suffices.
    expect(card.securityRequirements).toEqual(
      Object.keys(card.securitySchemes).map((name) => ({ [name]: [] })),
    );
  });

  test("capabilities carry only v1.0 fields", async () => {
    const card = (await fetchCard()).json();

    expect(card.capabilities).toEqual({
      streaming: true,
      pushNotifications: true,
      extendedAgentCard: false,
    });
    // stateTransitionHistory is a pre-1.0 field; a strict validator rejects it.
    expect(card.capabilities).not.toHaveProperty("stateTransitionHistory");
  });

  test("advertises the media types we actually accept, and skills carry tags", async () => {
    const card = (await fetchCard()).json();

    // We accept text parts, so the card must not claim JSON-only.
    expect(card.defaultInputModes).toContain("text/plain");
    expect(card.defaultOutputModes).toContain("text/plain");

    // tags is REQUIRED by the spec and drives LLM agent selection.
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0].tags.length).toBeGreaterThan(0);
    expect(card.skills[0].examples.length).toBeGreaterThan(0);
    expect(card.documentationUrl).toEqual(expect.any(String));
  });

  test("names the provider running the agent", async () => {
    const card = (await fetchCard()).json();

    // Both fields are REQUIRED by AgentProvider, so an empty string is as
    // broken as a missing key.
    expect(card.provider.organization).toEqual(expect.any(String));
    expect(card.provider.organization.length).toBeGreaterThan(0);
    // The deployment itself, not the vendor docs link carried separately.
    expect(card.provider.url).toMatch(/^https?:\/\//);
    expect(card.provider.url).not.toBe(card.documentationUrl);
  });

  test("version tracks the agent so a cached card cannot go stale", async () => {
    const card = (await fetchCard()).json();
    // "1" was the old hardcoded value — it could never invalidate a cache.
    expect(card.version).not.toBe("1");
    expect(card.version).toMatch(/^\d+$/);
  });

  test("serves an ETag and answers a matching conditional request with 304", async () => {
    const first = await fetchCard();
    const etag = first.headers.etag as string;

    expect(etag).toEqual(expect.any(String));
    expect(first.headers["cache-control"]).toContain("max-age");

    const conditional = await fetchCard({ "if-none-match": etag });
    expect(conditional.statusCode).toBe(304);
    expect(conditional.body).toBe("");
  });

  test("401s carry WWW-Authenticate so a client knows what to retry with", async () => {
    const missing = await app.inject({ method: "GET", url: cardUrl });
    expect(missing.statusCode).toBe(401);
    expect(missing.headers["www-authenticate"]).toContain("Bearer");

    mockValidateMCPGatewayToken.mockResolvedValue(null);
    const invalid = await fetchCard();
    expect(invalid.statusCode).toBe(401);
    expect(invalid.headers["www-authenticate"]).toContain("invalid_token");
  });

  test("advertises https for a non-local host without a forwarded proto", async () => {
    // A proxy that drops x-forwarded-proto must not make us publish a
    // downgrade in the artifact clients dial.
    const remote = (await fetchCard({ host: "agents.example.com" })).json();
    expect(remote.supportedInterfaces[0].url).toMatch(
      /^https:\/\/agents\.example\.com\//,
    );

    const forwarded = (
      await fetchCard({
        host: "agents.example.com",
        "x-forwarded-proto": "http",
      })
    ).json();
    expect(forwarded.supportedInterfaces[0].url).toMatch(/^http:\/\//);

    // Local development keeps plain http.
    const local = (await fetchCard({ host: "localhost:9000" })).json();
    expect(local.supportedInterfaces[0].url).toMatch(/^http:\/\/localhost/);
  });
});

describe("a2a v2 version negotiation", () => {
  let app: FastifyInstanceWithZod;
  let agentId: string;

  beforeEach(async ({ makeInternalAgent, makeUser, makeMember }) => {
    const agent = await makeInternalAgent();
    const user = await makeUser();
    await makeMember(user.id, agent.organizationId);
    agentId = agent.id;

    mockValidateMCPGatewayToken.mockResolvedValue({
      organizationId: agent.organizationId,
      userId: user.id,
    });

    app = createFastifyInstance();
    const { default: a2aV2Routes } = await import("./v2");
    await app.register(a2aV2Routes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    mockValidateMCPGatewayToken.mockReset();
    await app.close();
  });

  const listTasks = (version?: string) =>
    app.inject({
      method: "POST",
      url: `/v2/a2a/${agentId}`,
      headers: {
        authorization: "Bearer test-token",
        ...(version === undefined ? {} : { "a2a-version": version }),
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "ListTasks",
        params: { pageSize: 1 },
      },
    });

  test.for([
    ["absent", undefined],
    ["empty", ""],
    ["0.3", "0.3"],
    ["1.0", "1.0"],
  ])("serves %s", async ([, version]) => {
    const body = (await listTasks(version as string | undefined)).json();
    expect(body.error).toBeUndefined();
    expect(body.result.tasks).toEqual([]);
  });

  test.for([
    ["2.0"],
    ["0.5"],
    ["nonsense"],
  ])("rejects %s with VersionNotSupportedError", async ([version]) => {
    const body = (await listTasks(version)).json();
    // Silently serving 1.0 semantics to a client that asked for something
    // else is the failure this guards against.
    expect(body.error.code).toBe(-32009);
    expect(body.error.message).toContain("1.0");
  });

  test("an unknown agent is an invalid parameter, not InvalidAgentResponse", async () => {
    const body = (
      await app.inject({
        method: "POST",
        url: `/v2/a2a/${crypto.randomUUID()}`,
        headers: { authorization: "Bearer test-token" },
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method: "ListTasks",
          params: {},
        },
      })
    ).json();

    // -32006 is the spec's InvalidAgentResponseError, which this is not.
    expect(body.error.code).toBe(-32602);
  });
});
