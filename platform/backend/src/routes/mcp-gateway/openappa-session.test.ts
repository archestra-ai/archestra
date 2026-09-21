/** The OpenAPPA session a gateway caller names is the caller's own. */
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
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import mcpGatewayRoutes from "./index";

const native = vi.hoisted(() => ({
  initializeOpenappa: vi.fn(),
  dispatchHook: vi.fn(),
  executeRemedyByOffer: vi.fn(),
  loadOfferReview: vi.fn(async () => null),
  // No batteries installed: the composed policy is the root alone.
  listBundledOpenappaBatteries: vi.fn(async () => []),
  composeOpenappaPolicy: vi.fn(async (input: { root: string }) => ({
    content: input.root,
    errors: [],
  })),
}));
vi.mock("@archestra/openappa-rs", () => native);

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
    const agent = await makeAgent();
    const org = await makeOrganization();
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
