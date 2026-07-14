import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { OAuthAccessTokenModel, TeamTokenModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test, vi } from "@/test";
import mcpGatewayRoutes, {
  MCP_GATEWAY_TOKEN_VALIDATION_UNAVAILABLE_MESSAGE,
} from "./mcp-gateway";

/**
 * Pins the 401-vs-503 contract of gateway token validation.
 *
 * When the backend cannot check a token (database unreachable during a pod
 * restart, pool exhausted by a rollout surge, ...), the gateway must answer
 * 503 WITHOUT a WWW-Authenticate challenge. A 401 here is what used to force
 * MCP clients (e.g. Claude Code) to discard their valid, database-backed
 * tokens and re-run the whole OAuth flow on every restart. 401 stays reserved
 * for tokens the database affirmatively rejected.
 */
describe("MCP Gateway token validation during a backend outage", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(mcpGatewayRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  function injectPost(params: { agentId: string; token: string }) {
    return app.inject({
      method: "POST",
      url: `/v1/mcp/${params.agentId}`,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${params.token}`,
      },
      payload: {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
        id: 1,
      },
    });
  }

  test("POST answers 503 without WWW-Authenticate when the OAuth token lookup fails", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    vi.spyOn(OAuthAccessTokenModel, "getByTokenHash").mockRejectedValue(
      new Error("connection terminated unexpectedly"),
    );

    const response = await injectPost({
      agentId: agent.id,
      token: "OpaqueOauthTokenIssuedBeforeTheRestart",
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers["www-authenticate"]).toBeUndefined();
    expect(response.headers["retry-after"]).toBe("5");
    expect(response.json()).toEqual({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: MCP_GATEWAY_TOKEN_VALIDATION_UNAVAILABLE_MESSAGE,
      },
      id: null,
    });
  });

  test("POST answers 503 without WWW-Authenticate when an archestra token lookup fails", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    vi.spyOn(TeamTokenModel, "validateToken").mockRejectedValue(
      new Error("sorry, too many clients already"),
    );

    const response = await injectPost({
      agentId: agent.id,
      token: "archestra_team_token_during_db_outage",
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers["www-authenticate"]).toBeUndefined();
    expect(response.json().error.message).toBe(
      MCP_GATEWAY_TOKEN_VALIDATION_UNAVAILABLE_MESSAGE,
    );
  });

  test("GET answers 503 without WWW-Authenticate when token validation fails", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    vi.spyOn(OAuthAccessTokenModel, "getByTokenHash").mockRejectedValue(
      new Error("connection terminated unexpectedly"),
    );

    const response = await app.inject({
      method: "GET",
      url: `/v1/mcp/${agent.id}`,
      headers: {
        authorization: "Bearer OpaqueOauthTokenIssuedBeforeTheRestart",
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers["www-authenticate"]).toBeUndefined();
    expect(response.headers["retry-after"]).toBe("5");
    expect(response.json()).toEqual({
      error: "Service Unavailable",
      message: MCP_GATEWAY_TOKEN_VALIDATION_UNAVAILABLE_MESSAGE,
    });
  });

  test("a token the database affirmatively rejects still answers 401 with WWW-Authenticate", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();

    const response = await injectPost({
      agentId: agent.id,
      token: "OpaqueTokenThatExistsNowhere",
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toContain(
      "resource_metadata=",
    );
    expect(response.json().error.message).toBe(
      "Unauthorized: Invalid token for this profile",
    );
  });
});
