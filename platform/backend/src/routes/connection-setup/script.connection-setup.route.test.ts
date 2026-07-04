import {
  CLAUDE_CODE_CLIENT_ID,
  EXTERNAL_AGENT_ID_HEADER,
} from "@archestra/shared";
import { vi } from "vitest";
import {
  ConnectionSetupModel,
  MemberModel,
  SkillModel,
  SkillShareLinkModel,
  VirtualApiKeyModel,
} from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");

// cacheManager needs a live PostgreSQL connection that PGlite tests don't
// have; back it with the canonical Map-backed fake from
// src/__mocks__/cache-manager.ts so the rate limiter runs for real against an
// in-memory store (reset before every test).
vi.mock("@/cache-manager");

import { userHasPermission } from "@/auth";

const mockUserHasPermission = vi.mocked(userHasPermission);

// The client-app attribution header is always injected for Claude clients,
// independent of the passthrough virtual key.
const AGENT_ID_HEADER_LINE = `${EXTERNAL_AGENT_ID_HEADER}: ${CLAUDE_CODE_CLIENT_ID}`;

let remoteAddressCounter = 0;
/** Unique IP per request batch so the per-IP rate limit never bleeds between tests. */
function nextRemoteAddress(): string {
  remoteAddressCounter += 1;
  return `10.1.${Math.floor(remoteAddressCounter / 250)}.${(remoteAddressCounter % 250) + 1}`;
}

describe("GET /api/connection-setups/script/:token", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    await makeMember(user.id, organizationId);
    mockUserHasPermission.mockReset();
    mockUserHasPermission.mockResolvedValue(true);

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
    await app.close();
  });

  async function createSetup(payload: Record<string, unknown>) {
    const response = await app.inject({
      method: "POST",
      url: "/api/connection-setups",
      payload,
    });
    expect(response.statusCode).toBe(200);
    const command: string = response.json().command;
    const rawToken = command.match(/script\/([^']+)'/)?.[1] as string;
    expect(rawToken).toBeTruthy();
    return { rawToken, command };
  }

  function fetchScript(rawToken: string) {
    return app.inject({
      method: "GET",
      url: `/api/connection-setups/script/${rawToken}`,
      remoteAddress: nextRemoteAddress(),
    });
  }

  test("404s an unknown token", async () => {
    const response = await fetchScript("archestra_con_does-not-exist-at-all");
    expect(response.statusCode).toBe(404);
  });

  test("renders the script once, with secrets injected, then 410s", async ({
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const gateway = await makeAgent({
      organizationId,
      agentType: "mcp_gateway",
      name: "Prod Gateway",
    });
    const proxy = await makeAgent({
      organizationId,
      agentType: "llm_proxy",
      name: "Main Proxy",
    });
    await makeLlmProviderApiKey(organizationId, (await makeSecret()).id, {
      provider: "anthropic",
    });
    const skill = await seedSkill({ organizationId, name: "alpha" });

    const { rawToken } = await createSetup({
      clientId: "claude-code",
      baseUrl: "http://localhost:9000/v1",
      mcpGatewayId: gateway.id,
      llmProxyId: proxy.id,
      provider: "anthropic",
      proxyAuth: "virtual-key",
      skills: { skillIds: [skill.id], ttlDays: 30 },
    });

    const response = await fetchScript(rawToken);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.headers["cache-control"]).toBe("no-store");

    const script = response.body;
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("claude mcp add --transport http 'prod_gateway'");
    expect(script).toContain(`/v1/mcp/${gateway.slug ?? gateway.id}`);
    expect(script).toContain(`/v1/anthropic/${proxy.id}`);
    // the real virtual key value is injected, no placeholders
    expect(script).toMatch(/arch_[0-9a-f]{64}/);
    expect(script).not.toMatch(/<your-[a-z-]+>/);
    // skill share link was lazily created and embedded as a clone URL
    expect(script).toContain("/skills/m/archestra_skl_");
    const links = await SkillShareLinkModel.listByOrganization({
      organizationId,
    });
    expect(links).toHaveLength(1);

    // one-time: the second fetch is refused
    const second = await fetchScript(rawToken);
    expect(second.statusCode).toBe(410);
  });

  test("windows platform yields an irm|iex command and a PowerShell script", async ({
    makeAgent,
  }) => {
    const gateway = await makeAgent({
      organizationId,
      agentType: "mcp_gateway",
      name: "Prod Gateway",
    });

    const { rawToken, command } = await createSetup({
      clientId: "claude-code",
      platform: "windows",
      baseUrl: "http://localhost:9000/v1",
      mcpGatewayId: gateway.id,
    });
    expect(command).toContain("irm '");
    expect(command).toContain("| iex");
    expect(command).not.toContain("curl");

    const response = await fetchScript(rawToken);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    const script = response.body;
    expect(script).toContain("$ErrorActionPreference = 'Stop'");
    expect(script).not.toContain("set -euo pipefail");
    expect(script).toContain("claude mcp add --transport http 'prod_gateway'");
  });

  test("default platform (omitted) renders bash", async ({ makeAgent }) => {
    const gateway = await makeAgent({
      organizationId,
      agentType: "mcp_gateway",
      name: "Prod Gateway",
    });
    const { rawToken, command } = await createSetup({
      clientId: "claude-code",
      baseUrl: "http://localhost:9000/v1",
      mcpGatewayId: gateway.id,
    });
    expect(command).toContain("curl -fsSL");
    const response = await fetchScript(rawToken);
    expect(response.body).toContain("set -euo pipefail");
  });

  test("provider-key (passthrough) script rewires the base URL without any virtual key, still carrying the client-app agent-id header", async ({
    makeAgent,
  }) => {
    const proxy = await makeAgent({
      organizationId,
      agentType: "llm_proxy",
      name: "Main Proxy",
    });

    const { rawToken } = await createSetup({
      clientId: "claude-code",
      baseUrl: "http://localhost:9000/v1",
      llmProxyId: proxy.id,
      provider: "anthropic",
      attributePassthrough: false,
    });

    const response = await fetchScript(rawToken);
    expect(response.statusCode).toBe(200);
    const script = response.body;
    expect(script).toContain(`/v1/anthropic/${proxy.id}`);
    expect(script).toContain("ANTHROPIC_BASE_URL");
    // passthrough, attribution off: no injected virtual key, no auth token — but
    // the client-app agent-id header always rides along, so the header block is
    // still emitted (carrying only the agent id).
    expect(script).not.toMatch(/arch_[0-9a-f]{64}/);
    expect(script).not.toContain("ANTHROPIC_AUTH_TOKEN");
    expect(script).toContain(
      "export ARCHESTRA_APPEND_ANTHROPIC_CUSTOM_HEADERS",
    );
    expect(script).toContain(AGENT_ID_HEADER_LINE);
    expect(script).toContain("credentials keep working");
  });

  test("claude-code anthropic passthrough injects the X-Archestra-Virtual-Key header by default", async ({
    makeAgent,
  }) => {
    const proxy = await makeAgent({
      organizationId,
      agentType: "llm_proxy",
      name: "Main Proxy",
    });

    const { rawToken } = await createSetup({
      clientId: "claude-code",
      baseUrl: "http://localhost:9000/v1",
      llmProxyId: proxy.id,
      provider: "anthropic",
    });

    const response = await fetchScript(rawToken);
    expect(response.statusCode).toBe(200);
    const script = response.body;
    expect(script).toContain("ANTHROPIC_BASE_URL");
    // the provisioned passthrough key rides in the attribution header, but the
    // subscription still passes through (no auth token override)
    expect(script).toContain(
      "export ARCHESTRA_APPEND_ANTHROPIC_CUSTOM_HEADERS",
    );
    expect(script).toMatch(/X-Archestra-Virtual-Key: arch_[0-9a-f]{64}/);
    expect(script).not.toContain("ANTHROPIC_AUTH_TOKEN");
  });

  test("claude-code bedrock passthrough injects the X-Archestra-Virtual-Key header by default", async ({
    makeAgent,
  }) => {
    const proxy = await makeAgent({
      organizationId,
      agentType: "llm_proxy",
      name: "Main Proxy",
    });

    const { rawToken } = await createSetup({
      clientId: "claude-code",
      baseUrl: "http://localhost:9000/v1",
      llmProxyId: proxy.id,
      provider: "bedrock",
    });

    const response = await fetchScript(rawToken);
    expect(response.statusCode).toBe(200);
    const script = response.body;
    expect(script).toContain("CLAUDE_CODE_USE_BEDROCK");
    expect(script).toContain(`/v1/bedrock/${proxy.id}`);
    // The provisioned passthrough key rides in the attribution header alongside
    // the agent-id line, exactly like the Anthropic passthrough; the user's own
    // AWS credentials keep passing through (no bearer token is printed).
    expect(script).toContain(
      "export ARCHESTRA_APPEND_ANTHROPIC_CUSTOM_HEADERS",
    );
    expect(script).toContain(AGENT_ID_HEADER_LINE);
    expect(script).toMatch(/X-Archestra-Virtual-Key: arch_[0-9a-f]{64}/);
    expect(script).not.toContain("AWS_BEARER_TOKEN_BEDROCK");
  });

  test("a revoked attribution key degrades gracefully: script drops the virtual-key header but keeps the agent-id, no 410", async ({
    makeAgent,
  }) => {
    const proxy = await makeAgent({
      organizationId,
      agentType: "llm_proxy",
      name: "Main Proxy",
    });

    const { rawToken } = await createSetup({
      clientId: "claude-code",
      baseUrl: "http://localhost:9000/v1",
      llmProxyId: proxy.id,
      provider: "anthropic",
    });

    // Revoke the provisioned passthrough key between POST and GET.
    const setup = await ConnectionSetupModel.findByToken(rawToken);
    expect(setup?.virtualApiKeyId).toBeTruthy();
    await VirtualApiKeyModel.delete(setup?.virtualApiKeyId as string);

    const response = await fetchScript(rawToken);
    // Best-effort: the subscription still passes through, so we render (200),
    // just without the revoked passthrough virtual-key header — never a 410. The
    // client-app agent-id header is independent of the key, so it stays.
    expect(response.statusCode).toBe(200);
    const script = response.body;
    expect(script).toContain("ANTHROPIC_BASE_URL");
    expect(script).toContain(
      "export ARCHESTRA_APPEND_ANTHROPIC_CUSTOM_HEADERS",
    );
    expect(script).toContain(AGENT_ID_HEADER_LINE);
    expect(script).not.toMatch(/X-Archestra-Virtual-Key: arch_[0-9a-f]{64}/);
  });

  test("github-copilot passthrough script embeds the in-script GitHub device flow", async ({
    makeAgent,
  }) => {
    const proxy = await makeAgent({
      organizationId,
      agentType: "llm_proxy",
      name: "Main Proxy",
    });

    const { rawToken } = await createSetup({
      clientId: "copilot-cli",
      baseUrl: "http://localhost:9000/v1",
      llmProxyId: proxy.id,
      provider: "github-copilot",
    });

    const response = await fetchScript(rawToken);
    expect(response.statusCode).toBe(200);
    const script = response.body;
    expect(script).toContain(`/v1/github-copilot/${proxy.id}`);
    // device-flow endpoints come from backend config
    expect(script).toContain("/login/device/code");
    expect(script).toContain("copilot_internal/v2/token");
    // token obtained at runtime, not injected server-side
    expect(script).toContain("ARCHESTRA_GHCP_TOKEN");
    expect(script).not.toMatch(/arch_[0-9a-f]{64}/);
  });

  test("github-copilot is rejected for clients that do not support it", async ({
    makeAgent,
  }) => {
    const proxy = await makeAgent({
      organizationId,
      agentType: "llm_proxy",
      name: "Main Proxy",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/connection-setups",
      payload: {
        clientId: "claude-code",
        baseUrl: "http://localhost:9000/v1",
        llmProxyId: proxy.id,
        provider: "github-copilot",
      },
    });
    expect(response.statusCode).toBe(400);
  });

  test("410s without burning the token when re-validation fails, then succeeds after access is restored", async ({
    makeAgent,
  }) => {
    const gateway = await makeAgent({
      organizationId,
      agentType: "mcp_gateway",
      name: "Gate",
    });
    const { rawToken } = await createSetup({
      clientId: "codex",
      baseUrl: "http://localhost:9000/v1",
      mcpGatewayId: gateway.id,
    });

    // access revoked between POST and GET
    mockUserHasPermission.mockResolvedValue(false);
    const denied = await fetchScript(rawToken);
    expect(denied.statusCode).toBe(410);

    // rollback preserved the one-time token: restoring access lets it render
    mockUserHasPermission.mockResolvedValue(true);
    const allowed = await fetchScript(rawToken);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body).toContain("codex mcp add 'gate'");
  });

  test("410s when the creator's org membership is gone", async ({
    makeAgent,
  }) => {
    const gateway = await makeAgent({
      organizationId,
      agentType: "mcp_gateway",
    });
    const { rawToken } = await createSetup({
      clientId: "cursor",
      baseUrl: "http://localhost:9000/v1",
      mcpGatewayId: gateway.id,
    });

    await MemberModel.deleteAllByUserId(user.id);

    const response = await fetchScript(rawToken);
    expect(response.statusCode).toBe(410);
  });

  test("rate limits repeated probes from one IP", async () => {
    const ip = nextRemoteAddress();
    let limited = false;
    for (let i = 0; i < 11; i++) {
      const response = await app.inject({
        method: "GET",
        url: "/api/connection-setups/script/archestra_con_probe-attempt",
        remoteAddress: ip,
      });
      if (response.statusCode === 429) {
        limited = true;
        break;
      }
      expect(response.statusCode).toBe(404);
    }
    expect(limited).toBe(true);
  });
});

async function seedSkill(params: { organizationId: string; name: string }) {
  const skill = await SkillModel.createWithFiles({
    skill: {
      organizationId: params.organizationId,
      authorId: null,
      name: params.name,
      description: `${params.name} description`,
      content: `# ${params.name}`,
      metadata: {},
      sourceType: "manual",
      scope: "org",
    },
    files: [],
  });
  if (!skill) throw new Error("failed to seed skill");
  return skill;
}
