/** The OpenAPPA session a gateway caller names is the caller's own. */
import { TOOL_RUN_TOOL_FULL_NAME } from "@archestra/shared";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import config, { parseOpenAppaConfig } from "@/config";
import * as database from "@/database";
import { TeamTokenModel, UserTokenModel } from "@/models";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import { signOfferClaims, unsignedOfferClaims } from "@/openappa/offer-claims";
import {
  CONNECTION_SETUP_CONTEXT_PARAM,
  issueConnectionSetupContext,
} from "@/services/connection-setup-context";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import mcpGatewayRoutes from "./index";

const native = vi.hoisted(() => ({
  initializeOpenappa: vi.fn(),
  dispatchHook: vi.fn(),
  executeRemedyByOffer: vi.fn(),
  loadOfferReview: vi.fn(async () => null),
  // No batteries declared: the composed policy is the root alone.
  listBundledOpenappaBatteries: vi.fn(async () => []),
  parseOpenappaDeclarations: vi.fn(async () => ({
    include: [],
    serverAliases: [],
    credentials: [],
    routedAnnotators: [],
    runtimeCredentials: [],
    errors: [],
  })),
  composeOpenappaPolicy: vi.fn(async (input: { root: string }) => ({
    content: input.root,
    errors: [],
  })),
}));
vi.mock("@archestra/openappa-rs", () => native);
vi.mock("@/cache-manager");

describe("OpenAPPA sessions on the MCP gateway", () => {
  let app: FastifyInstance;
  let openappa: typeof config.openappa;

  beforeEach(async () => {
    openappa = config.openappa;
    config.openappa = parseOpenAppaConfig("true");
    await GuardrailsDeploymentModel.setEnabled(true);
    vi.spyOn(database, "getDatabaseConnectionString").mockReturnValue(
      "postgresql://test:test@localhost/test?schema=public",
    );
    native.initializeOpenappa.mockResolvedValue(undefined);
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(mcpGatewayRoutes);
  });

  afterEach(async () => {
    config.openappa = openappa;
    vi.restoreAllMocks();
    await app.close();
  });

  describe("signed installer context", () => {
    const secret = "test-offer-signing-secret-32chars";
    let agentId: string;
    let organizationId: string;
    let userId: string;
    let userToken: string;
    let toolName: string;
    let runToolAgentId: string;

    beforeEach(
      async ({
        makeAgent,
        makeAgentTool,
        makeInternalMcpCatalog,
        makeMember,
        makeMcpServer,
        makeTool,
        makeToolPolicy,
        makeUser,
      }) => {
        config.openappa = { ...config.openappa, offerSigningSecret: secret };
        const agent = await makeAgent({ agentType: "mcp_gateway" });
        const user = await makeUser();
        await makeMember(user.id, agent.organizationId, { role: "admin" });
        userToken = (await UserTokenModel.create(user.id, agent.organizationId))
          .value;
        const catalog = await makeInternalMcpCatalog({
          organizationId: agent.organizationId,
        });
        await makeMcpServer({
          catalogId: catalog.id,
          ownerId: user.id,
          scope: "personal",
        });
        const tool = await makeTool({
          catalogId: catalog.id,
          name: `connection_policy_${crypto.randomUUID().slice(0, 8)}`,
        });
        await makeAgentTool(agent.id, tool.id);
        await makeToolPolicy(tool.id, {
          action: "block_always",
          reason: "Outside setup",
          conditions: [
            { key: "recipient", operator: "equal", value: "external" },
          ],
        });
        const runToolAgent = await makeAgent({
          organizationId: agent.organizationId,
          agentType: "mcp_gateway",
          toolExposureMode: "search_and_run_only",
        });
        await makeAgentTool(runToolAgent.id, tool.id);
        agentId = agent.id;
        organizationId = agent.organizationId;
        userId = user.id;
        toolName = tool.name;
        runToolAgentId = runToolAgent.id;
      },
    );

    function gatewayUrl(profileId: string, setupContext?: string) {
      const url = new URL(`http://localhost/v1/mcp/${profileId}`);
      if (setupContext) {
        url.searchParams.set(CONNECTION_SETUP_CONTEXT_PARAM, setupContext);
      }
      return `${url.pathname}${url.search}`;
    }

    function issue(params: {
      userId?: string;
      organizationId?: string;
      gatewayId?: string;
    }) {
      return issueConnectionSetupContext({
        userId: params.userId ?? userId,
        organizationId: params.organizationId ?? organizationId,
        gatewayId: params.gatewayId ?? agentId,
        setupId: crypto.randomUUID(),
        secret,
      });
    }

    function call(params: {
      profileId?: string;
      token?: string;
      setupContext?: string;
      sessionId?: string;
      viaRunTool?: boolean;
    }) {
      return app.inject({
        method: "POST",
        url: gatewayUrl(params.profileId ?? agentId, params.setupContext),
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${params.token ?? userToken}`,
          ...(params.sessionId
            ? { "x-appa-session-id": params.sessionId }
            : {}),
        },
        payload: {
          jsonrpc: "2.0",
          method: "tools/call",
          params: params.viaRunTool
            ? {
                name: TOOL_RUN_TOOL_FULL_NAME,
                arguments: {
                  tool_name: toolName,
                  tool_args: { recipient: "external" },
                },
              }
            : { name: toolName, arguments: { recipient: "external" } },
          id: 1,
        },
      });
    }

    test("bypasses the block for a signed URL and matching user token with no session header", async () => {
      const allowed = await call({ setupContext: issue({}) });
      expect(allowed.statusCode, allowed.body).toBe(200);
      expect(allowed.body).not.toContain("Outside setup");

      const nested = await call({
        profileId: runToolAgentId,
        setupContext: issue({ gatewayId: runToolAgentId }),
        viaRunTool: true,
      });
      expect(nested.statusCode, nested.body).toBe(200);
      expect(nested.body).not.toContain("Outside setup");
    });

    test("blocks the same user on an unmarked URL", async () => {
      const blocked = await call({});
      expect(blocked.statusCode, blocked.body).toBe(200);
      expect(blocked.body).toContain("Outside setup");
      expect(
        (await call({ profileId: runToolAgentId, viaRunTool: true })).body,
      ).toContain("Outside setup");
    });

    test("blocks a different user, organization, or gateway", async ({
      makeMember,
      makeUser,
    }) => {
      const other = await makeUser();
      await makeMember(other.id, organizationId);
      const { value: otherToken } = await UserTokenModel.create(
        other.id,
        organizationId,
      );
      const signed = issue({});
      expect(
        (await call({ token: otherToken, setupContext: signed })).body,
      ).toContain("Outside setup");
      expect(
        (
          await call({
            setupContext: issue({ organizationId: crypto.randomUUID() }),
          })
        ).body,
      ).toContain("Outside setup");
      expect(
        (
          await call({
            setupContext: issue({ gatewayId: runToolAgentId }),
          })
        ).body,
      ).toContain("Outside setup");
      expect(
        (
          await call({
            profileId: runToolAgentId,
            setupContext: signed,
            viaRunTool: true,
          })
        ).body,
      ).toContain("Outside setup");
    });

    test("blocks a tampered signed context", async () => {
      const signed = issue({});
      const tampered = `${signed.slice(0, -1)}${signed.endsWith("A") ? "B" : "A"}`;
      const blocked = await call({ setupContext: tampered });
      expect(blocked.statusCode, blocked.body).toBe(200);
      expect(blocked.body).toContain("Outside setup");
    });

    test("rejects a signed context presented as Authorization", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/v1/mcp/${agentId}`,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${issue({})}`,
        },
        payload: {
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name: toolName, arguments: { recipient: "external" } },
          id: 1,
        },
      });
      expect(response.statusCode, response.body).toBe(401);
    });

    test("does not bypass for a client session header alone", async () => {
      const sessionId = crypto.randomUUID();
      const blocked = await call({ sessionId });
      expect(blocked.statusCode, blocked.body).toBe(200);
      expect(blocked.body).toContain("Outside setup");
      expect(
        (
          await call({
            profileId: runToolAgentId,
            sessionId,
            viaRunTool: true,
          })
        ).body,
      ).toContain("Outside setup");
    });
  });

  test("uses bounded logical metadata for an external remedy receipt", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    // The durable owner scopes the receipt by root and caller. JSON-RPC's
    // transport id is deliberately not used as a replay identity.
    const agent = await makeAgent();
    const user = await makeUser();
    await makeMember(user.id, agent.organizationId);
    const { value: token } = await UserTokenModel.create(
      user.id,
      agent.organizationId,
    );
    native.executeRemedyByOffer.mockResolvedValue(
      JSON.stringify({
        decision: "mcp_result",
        offer: { status: "unknown" },
        result: {
          isError: true,
          content: [
            { type: "text", text: "[appa] No live offer with this id" },
          ],
        },
      }),
    );
    const request = {
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "x-appa-session-id": "someone-elses-conversation",
      },
      payload: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "archestra__execute_remedy_plan",
          arguments: { offer_id: "offer-1" },
          _meta: { "com.archestra/logicalToolCallId": "logical-retry-1" },
        },
        id: "retry-1",
      },
    } as const;
    const response = await app.inject(request);
    const retry = await app.inject(request);

    expect(response.statusCode, response.body).toBe(200);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(JSON.stringify(response.json())).toContain("No live offer");
    expect(native.executeRemedyByOffer).not.toHaveBeenCalled();
    expect(native.dispatchHook).not.toHaveBeenCalled();
  });

  test("hands the runtime the dispatch tool a signed offer names", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    const agent = await makeAgent();
    const user = await makeUser();
    await makeMember(user.id, agent.organizationId);
    const { value: token } = await UserTokenModel.create(
      user.id,
      agent.organizationId,
    );
    const secret = "test-offer-signing-secret-32chars";
    config.openappa = { ...config.openappa, offerSigningSecret: secret };
    const jws = signOfferClaims(
      unsignedOfferClaims({
        organizationId: agent.organizationId,
        sessionId: "conversation",
        callerId: `user:${user.id}`,
        offerId: "offer-1",
        tool: "archestra__whoami",
        spelling: "archestra__whoami",
        dispatch: "my_gateway_archestra__run_tool",
      }),
      secret,
    );
    native.executeRemedyByOffer.mockResolvedValue(
      JSON.stringify({
        decision: "mcp_result",
        offer: { status: "known" },
        result: { content: [{ type: "text", text: "[appa] Authorized." }] },
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      payload: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "archestra__execute_remedy_plan",
          arguments: { offer_id: "offer-1", ...jws },
          _meta: { "com.archestra/logicalToolCallId": "logical-remedy-1" },
        },
        id: "remedy-1",
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(
      JSON.parse(native.executeRemedyByOffer.mock.calls[0][0]),
    ).toMatchObject({
      tool: "archestra__whoami",
      dispatch: "my_gateway_archestra__run_tool",
    });
  });

  test("uses untracked mode when an anonymous-token remedy has no logical id", async ({
    makeAgent,
    makeOrganization,
  }) => {
    // JSON-RPC ids are transport correlation values, not replay keys.
    // The token and the agent share an organization: a credential from another
    // organization is refused before any of this is reached.
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });
    native.executeRemedyByOffer.mockResolvedValue(
      JSON.stringify({
        decision: "mcp_result",
        offer: { status: "unknown" },
        result: {
          isError: true,
          content: [
            { type: "text", text: "[appa] No live offer with this id" },
          ],
        },
      }),
    );
    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token.value}`,
        "x-appa-session-id": "someone-elses-conversation",
      },
      payload: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "archestra__execute_remedy_plan",
          arguments: { offer_id: "offer-1" },
        },
        id: 4,
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(JSON.stringify(response.json())).toContain("No live offer");
    expect(native.executeRemedyByOffer).not.toHaveBeenCalled();
    expect(native.dispatchHook).not.toHaveBeenCalled();

    // An empty header is a malformed one, for this token too.
    const empty = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token.value}`,
        "x-appa-session-id": "",
      },
      payload: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "archestra__execute_remedy_plan",
          arguments: { offer_id: "offer-1" },
        },
        id: 5,
      },
    });
    expect(empty.statusCode).toBe(400);
  });

  test("answers a malformed session header as the caller's error", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    const agent = await makeAgent();
    const user = await makeUser();
    await makeMember(user.id, agent.organizationId);
    const { value: token } = await UserTokenModel.create(
      user.id,
      agent.organizationId,
    );

    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "x-appa-session-id": "bad\u0007session",
      },
      payload: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "archestra__execute_remedy_plan",
          arguments: { offer_id: "offer-1" },
        },
        id: 3,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: -32600,
        message: expect.stringContaining("X-Appa-Session-ID"),
      },
      id: 3,
    });
    expect(native.dispatchHook).not.toHaveBeenCalled();
  });
});
