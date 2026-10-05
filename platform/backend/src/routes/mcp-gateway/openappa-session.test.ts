/** The OpenAPPA session a gateway caller names is the caller's own. */
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  AgentWorkspaceModel,
  TeamTokenModel,
  UserTokenModel,
} from "@/models";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import { scopedSessionId } from "@/openappa/actor";
import { signOfferClaims, unsignedOfferClaims } from "@/openappa/offer-claims";
import {
  issueRuntimeBinding,
  RUNTIME_BINDING_HEADER,
  resolveGatewayRuntimeSession,
  stampRuntimeBinding,
  workloadPrincipal,
} from "@/services/agent-runtime/runtime-identity";
import {
  CONNECTION_SETUP_CONTEXT_PARAM,
  issueConnectionSetupContext,
} from "@/services/connection-setup-context";
import { afterEach, beforeEach, describe, expect, test } from "@/test";

const RUNTIME_BINDING_ENV = "ARCHESTRA_AGENT_RUNTIME_BINDING";

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

  test("a signed runtime binding spends as the workspace, and a sibling header does not", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const task = await A2ATaskModel.create({
      contextId: (
        await A2AContextModel.create({
          actorKind: "organization",
          actorId: org.id,
        })
      ).id,
      agentId: agent.id,
      state: "TASK_STATE_WORKING",
    });
    const workloadName = `workspace-${task.id}`;
    const workspace = await AgentWorkspaceModel.create({
      organizationId: org.id,
      agentId: agent.id,
      actorKind: "organization",
      actorId: org.id,
      backend: "kubernetes",
      runtimeScope: "test",
      workloadName,
      state: "active",
      activeTaskId: task.id,
      lastTaskId: task.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    await AgentRunModel.create({
      organizationId: org.id,
      taskId: task.id,
      agentId: agent.id,
      actorKind: "organization",
      actorId: org.id,
      actorUserId: null,
      workloadName,
      backend: "kubernetes",
      runtimeScope: "test",
    });
    const principal = workloadPrincipal(workspace.id);
    const secret = "test-offer-signing-secret-32chars";
    config.openappa = { ...config.openappa, offerSigningSecret: secret };
    const binding = issueRuntimeBinding({
      secret,
      organizationId: org.id,
      workspaceId: workspace.id,
      workloadName,
      taskId: task.id,
      agentId: agent.id,
      actorKind: "organization",
      actorId: org.id,
      expiresAt: Date.now() + 60_000,
    });
    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });
    const jws = signOfferClaims(
      unsignedOfferClaims({
        organizationId: org.id,
        sessionId: scopedSessionId(principal, workloadName),
        callerId: principal,
        offerId: "offer-runtime",
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
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token.value}`,
      [RUNTIME_BINDING_HEADER]: binding,
      "x-appa-session-id": workloadName,
      "x-archestra-run-id": task.id,
    };
    const payload = {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "archestra__execute_remedy_plan",
        arguments: { offer_id: "offer-runtime", plan: "keep", ...jws },
      },
      id: "runtime-remedy",
    };

    const accepted = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers,
      payload,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(
      JSON.parse(native.executeRemedyByOffer.mock.calls[0][0]),
    ).toMatchObject({ caller_id: principal, owner_caller_id: principal });

    native.executeRemedyByOffer.mockClear();
    const sibling = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: { ...headers, "x-appa-session-id": "workspace-sibling" },
      payload,
    });
    expect(sibling.statusCode).toBe(400);
    expect(native.executeRemedyByOffer).not.toHaveBeenCalled();
  });

  test("a stamped launch binding reaches the gateway through the Claude wrapper", async ({
    makeAgent,
    makeOrganization,
    makeTeam,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({ organizationId: org.id });
    const secret = "test-offer-signing-secret-32chars";
    config.openappa = { ...config.openappa, offerSigningSecret: secret };
    const first = await persistBoundRun({
      organizationId: org.id,
      agentId: agent.id,
      actorKind: "team",
      actorId: team.id,
    });
    const sibling = await persistBoundRun({
      organizationId: org.id,
      agentId: agent.id,
      actorKind: "team",
      actorId: team.id,
    });
    const spec = {
      env: {} as Record<string, string>,
      secretEnv: {} as Record<string, string>,
      activeDeadlineSeconds: 120,
    };
    await stampRuntimeBinding({
      spec,
      organizationId: org.id,
      workspaceId: first.workspace.id,
      taskId: first.task.id,
    });
    expect(spec.env).not.toHaveProperty(RUNTIME_BINDING_ENV);
    const expiring = {
      env: {} as Record<string, string>,
      secretEnv: {} as Record<string, string>,
      activeDeadlineSeconds: 1,
    };
    await stampRuntimeBinding({
      spec: expiring,
      organizationId: org.id,
      workspaceId: first.workspace.id,
      taskId: first.task.id,
    });
    expect(
      await resolveGatewayRuntimeSession({
        organizationId: org.id,
        agentId: agent.id,
        token: { teamId: team.id, isOrganizationToken: false },
        bindingToken: expiring.secretEnv[RUNTIME_BINDING_ENV],
        secret,
        sessionName: first.workspace.workloadName,
        runTaskId: first.task.id,
        now: Date.now() + 5_000,
      }),
    ).toMatchObject({ kind: "reject" });
    expect(
      await resolveGatewayRuntimeSession({
        organizationId: org.id,
        agentId: agent.id,
        token: { teamId: team.id, isOrganizationToken: false },
        bindingToken: spec.secretEnv[RUNTIME_BINDING_ENV],
        secret,
        sessionName: first.workspace.workloadName,
      }),
    ).toMatchObject({ kind: "reject" });
    const binding = spec.secretEnv[RUNTIME_BINDING_ENV];
    expect(binding).toBeTruthy();
    const wrapped = await claudeWrapperHeaders({
      binding,
      session: first.workspace.workloadName,
      taskId: first.task.id,
      gatewayUrl: `http://gateway/v1/mcp/${agent.id}`,
    });
    expect(wrapped.llm).toContain(`${RUNTIME_BINDING_HEADER}: ${binding}`);
    expect(wrapped.mcp).toBe(binding);
    const teamToken = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Matching Team",
      teamId: team.id,
      isOrganizationToken: false,
    });
    native.executeRemedyByOffer.mockResolvedValue(
      JSON.stringify({
        decision: "mcp_result",
        offer: { status: "known" },
        result: { content: [{ type: "text", text: "[appa] Authorized." }] },
      }),
    );
    const principal = workloadPrincipal(first.workspace.id);
    const jws = signOfferClaims(
      unsignedOfferClaims({
        organizationId: org.id,
        sessionId: scopedSessionId(principal, first.workspace.workloadName),
        callerId: principal,
        offerId: "offer-stamped",
      }),
      secret,
    );
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${teamToken.value}`,
      [RUNTIME_BINDING_HEADER]: wrapped.mcp,
      "x-appa-session-id": first.workspace.workloadName,
      "x-archestra-run-id": first.task.id,
    };
    const payload = {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "archestra__execute_remedy_plan",
        arguments: { offer_id: "offer-stamped", plan: "keep", ...jws },
      },
      id: "stamped-remedy",
    };
    const accepted = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers,
      payload,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(
      JSON.parse(native.executeRemedyByOffer.mock.calls[0][0]),
    ).toMatchObject({ caller_id: principal });

    native.executeRemedyByOffer.mockClear();
    const wrongKey = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: {
        ...headers,
        [RUNTIME_BINDING_HEADER]: await stampSibling(spec, org.id, sibling),
        "x-appa-session-id": first.workspace.workloadName,
        "x-archestra-run-id": first.task.id,
      },
      payload,
    });
    expect(wrongKey.statusCode).toBe(400);
    expect(native.executeRemedyByOffer).not.toHaveBeenCalled();

    const rotated = await persistContinuation(first);
    const rotatedSpec = {
      env: {} as Record<string, string>,
      secretEnv: {} as Record<string, string>,
      activeDeadlineSeconds: 90,
    };
    await stampRuntimeBinding({
      spec: rotatedSpec,
      organizationId: org.id,
      workspaceId: first.workspace.id,
      taskId: rotated.taskId,
    });
    expect(rotatedSpec.secretEnv[RUNTIME_BINDING_ENV]).not.toBe(binding);
    const rotatedHeaders = await claudeWrapperHeaders({
      binding: rotatedSpec.secretEnv[RUNTIME_BINDING_ENV],
      session: first.workspace.workloadName,
      taskId: rotated.taskId,
      gatewayUrl: `http://gateway/v1/mcp/${agent.id}`,
    });
    const continued = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: {
        ...headers,
        [RUNTIME_BINDING_HEADER]: rotatedHeaders.mcp,
        "x-archestra-run-id": rotated.taskId,
      },
      payload,
    });
    expect(continued.statusCode, continued.body).toBe(200);
    expect(
      JSON.parse(native.executeRemedyByOffer.mock.calls[0][0]),
    ).toMatchObject({ caller_id: principal });

    const systemRun = await persistBoundRun({
      organizationId: org.id,
      agentId: agent.id,
      actorKind: "system",
      actorId: "system",
    });
    const systemSpec = {
      env: {} as Record<string, string>,
      secretEnv: {} as Record<string, string>,
      activeDeadlineSeconds: 60,
    };
    await stampRuntimeBinding({
      spec: systemSpec,
      organizationId: org.id,
      workspaceId: systemRun.workspace.id,
      taskId: systemRun.task.id,
    });
    const orgToken = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });
    const systemPrincipal = workloadPrincipal(systemRun.workspace.id);
    native.executeRemedyByOffer.mockClear();
    const systemCall = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: {
        ...headers,
        authorization: `Bearer ${orgToken.value}`,
        [RUNTIME_BINDING_HEADER]: systemSpec.secretEnv[RUNTIME_BINDING_ENV],
        "x-appa-session-id": systemRun.workspace.workloadName,
        "x-archestra-run-id": systemRun.task.id,
      },
      payload: {
        ...payload,
        params: {
          ...payload.params,
          arguments: {
            offer_id: "offer-system",
            plan: "keep",
            ...signOfferClaims(
              unsignedOfferClaims({
                organizationId: org.id,
                sessionId: scopedSessionId(
                  systemPrincipal,
                  systemRun.workspace.workloadName,
                ),
                callerId: systemPrincipal,
                offerId: "offer-system",
              }),
              secret,
            ),
          },
        },
      },
    });
    expect(systemCall.statusCode, systemCall.body).toBe(200);
    expect(
      JSON.parse(native.executeRemedyByOffer.mock.calls[0][0]),
    ).toMatchObject({ caller_id: systemPrincipal });
  });
});

async function stampSibling(
  _spec: { env: Record<string, string>; secretEnv: Record<string, string> },
  organizationId: string,
  sibling: { workspace: { id: string }; task: { id: string } },
) {
  const spec = {
    env: {},
    secretEnv: {} as Record<string, string>,
    activeDeadlineSeconds: 60,
  };
  await stampRuntimeBinding({
    spec,
    organizationId,
    workspaceId: sibling.workspace.id,
    taskId: sibling.task.id,
  });
  return spec.secretEnv[RUNTIME_BINDING_ENV];
}

async function persistBoundRun(params: {
  organizationId: string;
  agentId: string;
  actorKind: "team" | "system";
  actorId: string;
}) {
  const task = await A2ATaskModel.create({
    contextId: (
      await A2AContextModel.create({
        actorKind: params.actorKind,
        actorId: params.actorId,
      })
    ).id,
    agentId: params.agentId,
    state: "TASK_STATE_WORKING",
  });
  const workloadName = `workspace-${task.id}`;
  const workspace = await AgentWorkspaceModel.create({
    organizationId: params.organizationId,
    agentId: params.agentId,
    actorKind: params.actorKind,
    actorId: params.actorId,
    backend: "kubernetes",
    runtimeScope: "test",
    workloadName,
    state: "active",
    activeTaskId: task.id,
    lastTaskId: task.id,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  await AgentRunModel.create({
    organizationId: params.organizationId,
    taskId: task.id,
    agentId: params.agentId,
    actorKind: params.actorKind,
    actorId: params.actorId,
    actorUserId: null,
    workloadName,
    backend: "kubernetes",
    runtimeScope: "test",
  });
  return { task, workspace };
}

async function persistContinuation(current: {
  workspace: {
    id: string;
    organizationId: string;
    agentId: string;
    actorKind: "team" | "system" | "organization" | "user";
    actorId: string;
    workloadName: string;
  };
}) {
  const task = await A2ATaskModel.create({
    contextId: (
      await A2AContextModel.create({
        actorKind: current.workspace.actorKind,
        actorId: current.workspace.actorId,
      })
    ).id,
    agentId: current.workspace.agentId,
    state: "TASK_STATE_WORKING",
  });
  await AgentRunModel.create({
    organizationId: current.workspace.organizationId,
    taskId: task.id,
    agentId: current.workspace.agentId,
    actorKind: current.workspace.actorKind,
    actorId: current.workspace.actorId,
    actorUserId: null,
    workloadName: current.workspace.workloadName,
    backend: "kubernetes",
    runtimeScope: "test",
  });
  return { taskId: task.id };
}

async function claudeWrapperHeaders(params: {
  binding: string;
  session: string;
  taskId: string;
  gatewayUrl: string;
}) {
  const dir = await mkdtemp(join(tmpdir(), "runtime-binding-"));
  const bin = join(dir, "bin");
  await mkdir(bin);
  const stub = join(bin, "claude");
  await writeFile(
    stub,
    '#!/bin/sh\nprintf \'%s\' "$ANTHROPIC_CUSTOM_HEADERS" > "$ARCHESTRA_AGENT_RUNTIME_DIR/llm-headers"\nexit 0\n',
  );
  await chmod(stub, 0o755);
  const script = join(
    process.cwd(),
    "../agent_images/bin/archestra-claude-code",
  );
  const result = spawnSync(script, [], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: dir,
      ARCHESTRA_AGENT_RUNTIME_DIR: dir,
      ARCHESTRA_LLM_PROXY_PROTOCOL: "anthropic",
      ARCHESTRA_AGENT_RUNTIME_MODE: "one_shot",
      ARCHESTRA_AGENT_RUNTIME_PLAIN: "1",
      ARCHESTRA_AGENT_RUNTIME_TASK: "continue the workspace",
      ARCHESTRA_AGENT_RUNTIME_OPENAPPA: "1",
      ARCHESTRA_AGENT_RUNTIME_BINDING: params.binding,
      ARCHESTRA_AGENT_RUNTIME_WORKSPACE_ID: params.session,
      ARCHESTRA_AGENT_RUNTIME_TASK_ID: params.taskId,
      ARCHESTRA_MCP_GATEWAY_URL: params.gatewayUrl,
      ARCHESTRA_MCP_GATEWAY_TOKEN: "gateway-token",
      ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL: "test-model",
    },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "wrapper failed");
  }
  const mcp = JSON.parse(
    await readFile(join(dir, "claude-mcp.json"), "utf8"),
  ) as {
    mcpServers: {
      archestra: { headers: Record<string, string> };
    };
  };
  return {
    llm: await readFile(join(dir, "llm-headers"), "utf8"),
    mcp: mcp.mcpServers.archestra.headers[RUNTIME_BINDING_HEADER],
  };
}
