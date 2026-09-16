import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import { TeamTokenModel } from "@/models";
import { MCP_RESOURCE_REFERENCE_PREFIX } from "@/services/identity-providers/enterprise-managed/authorization";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import oauthServerRoutes from "../oauth-server";
import mcpGatewayRoutes from "./index";

// The standalone GET stream records its session in the shared cache, which is
// Keyv over a real PostgreSQL connection — the unit suite runs on PGlite and
// never starts it, so the real manager would throw on the first write. The
// canonical fake has real cache semantics.
vi.mock("@/cache-manager");

describe("MCP Gateway GET transport", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(mcpGatewayRoutes);
    await app.register(oauthServerRoutes);
  });

  test("validates OAuth credentials on GET before initialization and preserves discovery", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeMember,
    makeOAuthClient,
    makeOAuthAccessToken,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
    });
    const otherAgent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
    });
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const client = await makeOAuthClient({ userId: user.id });

    for (const scenario of ["valid", "expired", "wrong-gateway"] as const) {
      const token = `test-oauth-token-${crypto.randomUUID()}`;
      await makeOAuthAccessToken(client.clientId, user.id, {
        token: createHash("sha256").update(token).digest("base64url"),
        referenceId: `${MCP_RESOURCE_REFERENCE_PREFIX}${scenario === "wrong-gateway" ? otherAgent.id : agent.id}`,
        ...(scenario === "expired" && {
          expiresAt: new Date(Date.now() - 60_000),
        }),
      });
      const response = await app.inject({
        method: "GET",
        url: `/v1/mcp/${agent.slug}`,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
      });
      expect(response.statusCode, scenario).toBe(
        scenario === "valid" ? 405 : 401,
      );
      if (scenario === "valid") {
        expect(response.headers.allow).toBe("POST");
      } else {
        const challenge = String(response.headers["www-authenticate"]);
        const metadataUrl = challenge.match(/resource_metadata="([^"]+)"/)?.[1];
        expect(metadataUrl).toBeDefined();
        const metadata = await app.inject({
          method: "GET",
          url: new URL(metadataUrl ?? "").pathname,
        });
        expect(metadata.statusCode).toBe(200);
        expect(new URL(metadata.json().resource).pathname).toBe(
          `/v1/mcp/${agent.slug}`,
        );
        expect(metadata.json().authorization_servers.length).toBeGreaterThan(0);
      }
    }
  });

  afterEach(async () => {
    await app.close();
  });

  test("declines GET for UUID and slug URLs unless an event stream is requested", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
    });
    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Gateway token",
      teamId: null,
      isOrganizationToken: true,
    });

    for (const identifier of [agent.id, agent.slug]) {
      for (const accept of ["application/json", "*/*", undefined]) {
        const response = await app.inject({
          method: "GET",
          url: `/v1/mcp/${identifier}`,
          headers: {
            authorization: `Bearer ${token.value}`,
            ...(accept && { accept }),
          },
        });

        expect(response.statusCode).toBe(405);
        expect(response.headers.allow).toBe("POST");
        expect(response.json()).not.toHaveProperty("agentId");
      }
    }
  });

  test("challenges missing, malformed, and invalid credentials for OAuth discovery", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ agentType: "mcp_gateway" });

    for (const authorization of [
      undefined,
      "Basic invalid",
      "Bearer archestra_invalid_token_12345",
    ]) {
      const response = await app.inject({
        method: "GET",
        url: `/v1/mcp/${agent.slug}`,
        headers: {
          accept: "text/event-stream",
          ...(authorization && { authorization }),
        },
      });

      expect(response.statusCode).toBe(401);
      expect(response.headers["www-authenticate"]).toContain(
        `/.well-known/oauth-protected-resource/v1/mcp/${agent.slug}`,
      );
      expect(response.json()).not.toHaveProperty("agentId");
    }
  });

  test.for([
    "id",
    "slug",
  ] as const)("a standard SDK client uses an OAuth token to connect, list, and call tools through the %s URL", async (identifier, {
    makeAgent,
    makeUser,
    makeOrganization,
    makeMember,
    makeOAuthClient,
    makeOAuthAccessToken,
    seedAndAssignArchestraTools,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
    });
    await seedAndAssignArchestraTools(agent.id);
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const oauthClient = await makeOAuthClient({ userId: user.id });
    const token = `test-oauth-token-${crypto.randomUUID()}`;
    await makeOAuthAccessToken(oauthClient.clientId, user.id, {
      token: createHash("sha256").update(token).digest("base64url"),
      referenceId: `${MCP_RESOURCE_REFERENCE_PREFIX}${agent.id}`,
    });
    // The standalone GET the SDK opens after `initialized` is held open as a
    // stream (hijacked, so response hooks never see it): count requests.
    let getRequests = 0;
    app.addHook("onRequest", async (request) => {
      if (request.method === "GET") getRequests += 1;
    });
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = new Client({ name: "gateway-test", version: "1.0.0" });
    const errors: Error[] = [];
    client.onerror = (error) => errors.push(error);

    try {
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`/v1/mcp/${agent[identifier]}`, origin),
          {
            requestInit: {
              headers: { authorization: `Bearer ${token}` },
            },
            reconnectionOptions: {
              initialReconnectionDelay: 25,
              maxReconnectionDelay: 25,
              reconnectionDelayGrowFactor: 1,
              maxRetries: 2,
            },
          },
        ),
      );
      await expect.poll(() => getRequests).toBe(1);

      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain("archestra__whoami");
      const result = await client.callTool({
        name: "archestra__whoami",
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining(agent.id),
          }),
        ]),
      );
      // Observe beyond the configured retry delay while the client stays open:
      // one held stream, no reconnect loop.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(getRequests).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await client.close();
    }
  });
});
