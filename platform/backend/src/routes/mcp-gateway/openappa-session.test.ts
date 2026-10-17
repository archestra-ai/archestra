/** The OpenAPPA session a gateway caller names is the caller's own. */
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import formbody from "@fastify/formbody";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import { A2AManager } from "@/agents/a2a/a2a-manager";
import config, { parseOpenAppaConfig } from "@/config";
import * as database from "@/database";
import { enterpriseTier } from "@/enterprise-tier";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  AgentWorkspaceModel,
  ServiceAccountModel,
  UserTokenModel,
} from "@/models";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import ManagedOauthClientModel from "@/models/managed-oauth-client";
import OpenAppaSessionModel from "@/models/openappa-session";
import OpenAppaYellModel from "@/models/openappa-yell";
import { scopedSessionId } from "@/openappa/actor";
import { currentTrajectory } from "@/openappa/current-trajectory";
import {
  observeUnenforcedSession,
  startedUnenforced,
} from "@/openappa/unenforced";
import authRoutes from "@/routes/auth";
import {
  issueRuntimeBinding,
  RUNTIME_BINDING_HEADER,
  resolveGatewayRuntimeSession,
  runtimeOpenAppaSession,
  stampRuntimeBinding,
  workloadPrincipal,
} from "@/services/agent-runtime/runtime-identity";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { AgentRunActorKind } from "@/types";

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
  validateHostedOpenappaPolicy: vi.fn(async () => []),
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
    config.openappa = parseOpenAppaConfig();
    await GuardrailsDeploymentModel.setEnabled(true);
    vi.spyOn(database, "getDatabaseConnectionString").mockReturnValue(
      "postgresql://test:test@localhost/test?schema=public",
    );
    native.initializeOpenappa.mockResolvedValue(undefined);
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(formbody);
    await app.register(authRoutes);
    await app.register(mcpGatewayRoutes);
  });

  afterEach(async () => {
    config.openappa = openappa;
    vi.restoreAllMocks();
    await app.close();
  });

  test("a user-scoped MCP client can yell without proxy state or logical call metadata", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    config.openappa.yellEnabled = true;
    await GuardrailsDeploymentModel.set({ breakTheGlassEnabled: false });
    const agent = await makeAgent();
    const user = await makeUser();
    await makeMember(user.id, agent.organizationId);
    const { value: token } = await UserTokenModel.create(
      user.id,
      agent.organizationId,
    );
    let released = false;
    native.dispatchHook.mockClear();
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      if (event.event === "tool_call") {
        expect(event.tool).toBe("yell");
        released = true;
        return JSON.stringify({ decision: "allow_call" });
      }
      // The native reporter needs a released call as well as a session.
      expect(event.event).toBe("yell");
      expect(released).toBe(true);
      released = false;
      return JSON.stringify({
        decision: "mcp_result",
        result: { content: [] },
      });
    });
    const args = { message: "Reporting feedback", with_trajectory: false };
    for (const wrapped of [false, true]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/mcp/${agent.id}`,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          "x-appa-session-id": "client-session",
        },
        payload: {
          jsonrpc: "2.0",
          method: "tools/call",
          params: wrapped
            ? {
                name: "archestra__run_tool",
                arguments: { tool_name: "archestra__yell", tool_args: args },
              }
            : { name: "archestra__yell", arguments: args },
          // A reused transport ID must not collapse distinct reports.
          id: 1,
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(JSON.stringify(response.json())).toContain(
        "Guardrails are unchanged for this session",
      );
    }
    const saved = await OpenAppaYellModel.list({
      organizationId: agent.organizationId,
      status: "all",
      limit: 20,
    });
    expect(saved.data).toHaveLength(2);
    expect(new Set(saved.data.map((report) => report.toolCallId)).size).toBe(2);
    for (const report of saved.data) {
      expect(report).toMatchObject({
        callerId: `user:${user.id}`,
        sessionId: scopedSessionId(`user:${user.id}`, "client-session"),
        message: args.message,
        superyell: false,
      });
      expect(report.toolCallId).not.toBe("1");
    }
    expect(
      native.dispatchHook.mock.calls.map(([raw]) => JSON.parse(raw).event),
    ).toEqual(["tool_call", "yell", "tool_call", "yell"]);
  });

  test.for([
    false,
    true,
  ])("a bound runtime can yell without proxy state (break the glass %s)", async (breakTheGlass, {
    makeAgent,
    makeOrganization,
    makeServiceAccount,
  }) => {
    config.openappa.yellEnabled = true;
    config.openappa.offerSigningSecret = "test-runtime-binding-secret-32chars";
    await GuardrailsDeploymentModel.set({
      breakTheGlassEnabled: breakTheGlass,
    });
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const account = await makeServiceAccount(org.id, { role: "admin" });
    const current = await persistBoundRun({
      organizationId: org.id,
      agentId: agent.id,
      actorKind: "serviceAccount",
      actorId: account.id,
    });
    const spec = {
      env: {},
      secretEnv: {} as Record<string, string>,
      activeDeadlineSeconds: 120,
    };
    await stampRuntimeBinding({
      spec,
      organizationId: org.id,
      workspaceId: current.workspace.id,
      taskId: current.task.id,
    });
    const runtimeToken = await ServiceAccountModel.createToken({
      serviceAccountId: account.id,
      organizationId: org.id,
      name: "Runtime gateway",
      expiresIn: 120,
    });
    const session = runtimeOpenAppaSession({
      organizationId: org.id,
      workspaceId: current.workspace.id,
      workloadName: current.workspace.workloadName,
      actorKind: "serviceAccount",
      actorId: account.id,
    });
    await observeUnenforcedSession(session);
    native.dispatchHook.mockClear();
    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${runtimeToken.token}`,
        [RUNTIME_BINDING_HEADER]: spec.secretEnv[RUNTIME_BINDING_ENV],
        "x-appa-session-id": current.workspace.workloadName,
        "x-archestra-run-id": current.task.id,
      },
      payload: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "archestra__yell",
          arguments: {
            message: "Runtime reporting feedback",
            with_trajectory: true,
          },
        },
        id: "runtime-report",
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(JSON.stringify(response.json())).toContain(
      breakTheGlass
        ? "Guardrails are now off for this session"
        : "Guardrails are unchanged for this session",
    );
    expect(JSON.stringify(response.json())).toContain(
      "No diagnostic archive was captured",
    );
    const saved = await OpenAppaYellModel.list({
      organizationId: org.id,
      status: "all",
      limit: 20,
    });
    expect(saved.data).toEqual([
      expect.objectContaining({
        callerId: session.caller_id,
        sessionId: session.session_id,
        superyell: breakTheGlass,
        withTrajectory: true,
      }),
    ]);
    expect(native.dispatchHook).not.toHaveBeenCalled();
    expect(
      await OpenAppaSessionModel.find({
        organizationId: org.id,
        sessionId: session.session_id,
      }),
    ).toBeNull();
    expect(await startedUnenforced(session)).toBe(true);
    expect(
      await startedUnenforced({ ...session, session_id: "another-workspace" }),
    ).toBe(false);
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

  test("hands the runtime the stamped child trajectory despite the gateway header", async ({
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
    const childId = "virtual-key:vk-1|parent-session:child-agent";
    const parentId = "virtual-key:vk-1|parent-session";
    native.executeRemedyByOffer.mockResolvedValue(
      JSON.stringify({
        decision: "mcp_result",
        offer: { status: "known" },
        result: { content: [{ type: "text", text: "[appa] Authorized." }] },
      }),
    );

    for (const gatewayHeader of ["absent", "parent"] as const) {
      native.executeRemedyByOffer.mockClear();
      const response = await app.inject({
        method: "POST",
        url: `/v1/mcp/${agent.id}`,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          ...(gatewayHeader === "parent"
            ? { "x-appa-session-id": "parent-session" }
            : {}),
        },
        payload: {
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: "archestra__execute_remedy_plan",
            arguments: {
              offer_id: "offer-1",
              protected: "e30",
              payload: "{}",
              signature: "sig",
              trajectory: currentTrajectory({
                session_id: childId,
                parent_id: parentId,
              }),
            },
            _meta: { "com.archestra/logicalToolCallId": "logical-remedy-1" },
          },
          id: "remedy-1",
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      const sent = JSON.parse(native.executeRemedyByOffer.mock.calls[0][0]);
      expect(sent.trajectory?.session_id ?? sent.session_id).toBe(childId);
      expect(sent.trajectory?.parent_id ?? sent.parent_id).toBe(parentId);
      expect(sent.caller_id).toBe(`user:${user.id}`);
      expect(sent.organization_id).toBe(agent.organizationId);
      expect(sent).not.toHaveProperty("tool");
      expect(sent).not.toHaveProperty("dispatch");
      expect(sent).not.toHaveProperty("owner_caller_id");
      expect(sent).not.toHaveProperty("spelling");
      expect(sent.session_id ?? sent.trajectory?.session_id).not.toBe(
        `user:${user.id}|parent-session`,
      );
    }
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
    const account = await ServiceAccountModel.create({
      organizationId: org.id,
      name: "automation",
      role: "member",
      createdBy: null,
    });
    const { token: value } = await ServiceAccountModel.createToken({
      serviceAccountId: account.id,
      organizationId: org.id,
      name: "ci",
    });
    const token = { value };
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
    makeServiceAccountToken,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const { serviceAccount: account, value: accountKey } =
      await makeServiceAccountToken({ organizationId: org.id });
    const task = await A2ATaskModel.create({
      contextId: (
        await A2AContextModel.create({
          actorKind: "serviceAccount",
          actorId: account.id,
        })
      ).id,
      agentId: agent.id,
      state: "TASK_STATE_WORKING",
    });
    const workloadName = `workspace-${task.id}`;
    const workspace = await AgentWorkspaceModel.create({
      organizationId: org.id,
      agentId: agent.id,
      actorKind: "serviceAccount",
      actorId: account.id,
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
      actorKind: "serviceAccount",
      actorId: account.id,
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
      actorKind: "serviceAccount",
      actorId: account.id,
      expiresAt: Date.now() + 60_000,
    });
    const trajectory = currentTrajectory({
      session_id: scopedSessionId(principal, workloadName),
    });
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
      authorization: `Bearer ${accountKey}`,
      [RUNTIME_BINDING_HEADER]: binding,
      "x-appa-session-id": workloadName,
      "x-archestra-run-id": task.id,
    };
    const payload = {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "archestra__execute_remedy_plan",
        arguments: { offer_id: "offer-runtime", plan: "keep", trajectory },
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
    ).toMatchObject({ caller_id: principal, trajectory });
    expect(
      JSON.parse(native.executeRemedyByOffer.mock.calls[0][0]),
    ).not.toHaveProperty("owner_caller_id");

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

  for (const scope of ["a2a", "a2a mcp"]) {
    test(`OAuth client credentials with scope ${scope} start an account-bound MCP session`, async ({
      makeOrganization,
      makeAgent,
      makeUser,
      makeServiceAccount,
    }) => {
      config.openappa.offerSigningSecret =
        "test-runtime-binding-secret-32chars";
      const org = await makeOrganization();
      const user = await makeUser();
      const agent = await makeAgent({ organizationId: org.id });
      const account = await makeServiceAccount(org.id, { role: "admin" });
      const otherAccount = await makeServiceAccount(org.id, { role: "admin" });
      const { oauthClient, clientSecret } =
        await ManagedOauthClientModel.create({
          organizationId: org.id,
          authorId: user.id,
          name: "Runtime automation",
          serviceAccountId: account.id,
          scopes: ["a2a", "mcp"],
          allowedGatewayIds: [agent.id],
        });
      const tokenResponse = await app.inject({
        method: "POST",
        url: "/api/auth/oauth2/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: oauthClient.clientId,
          client_secret: clientSecret,
          scope,
        }).toString(),
      });
      expect(tokenResponse.statusCode, tokenResponse.body).toBe(200);
      const oauthToken = tokenResponse.json().access_token;
      const actor = await new A2AManager().resolveActorByMCPGatewayToken(
        agent.id,
        oauthToken,
      );
      expect(actor).toMatchObject({ kind: "serviceAccount", id: account.id });
      const current = await persistBoundRun({
        organizationId: org.id,
        agentId: agent.id,
        actorKind: "serviceAccount",
        actorId: actor.id,
      });
      const spec = {
        env: {},
        secretEnv: {} as Record<string, string>,
        activeDeadlineSeconds: 120,
      };
      await stampRuntimeBinding({
        spec,
        organizationId: org.id,
        workspaceId: current.workspace.id,
        taskId: current.task.id,
      });
      // The runtime gets its own expiring account token, even when dispatch
      // uses an OAuth token with only the A2A scope.
      const runtimeToken = await ServiceAccountModel.createToken({
        serviceAccountId: account.id,
        organizationId: org.id,
        name: "Runtime gateway",
        expiresIn: 120,
      });
      const headers = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${runtimeToken.token}`,
        [RUNTIME_BINDING_HEADER]: spec.secretEnv[RUNTIME_BINDING_ENV],
        "x-archestra-run-id": current.task.id,
      };
      // A broad gateway grant must not let another account enter this workspace.
      const foreign = await ServiceAccountModel.createToken({
        serviceAccountId: otherAccount.id,
        organizationId: org.id,
        name: "Other runtime",
        expiresIn: 120,
      });
      const denied = await app.inject({
        method: "POST",
        url: `/v1/mcp/${agent.id}`,
        headers: { ...headers, authorization: `Bearer ${foreign.token}` },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      expect(denied.statusCode, denied.body).toBe(400);
      expect(denied.json().error.message).toBe(
        "OpenAPPA runtime credential does not match this run",
      );
      for (const credential of [
        runtimeToken.token,
        ...(scope.includes("mcp") ? [oauthToken] : []),
      ]) {
        for (const withSession of [false, true]) {
          for (const method of [
            "initialize",
            "notifications/initialized",
            "tools/list",
          ]) {
            const response = await app.inject({
              method: "POST",
              url: `/v1/mcp/${agent.id}`,
              headers: {
                ...headers,
                authorization: `Bearer ${credential}`,
                ...(withSession
                  ? { "x-appa-session-id": current.workspace.workloadName }
                  : {}),
              },
              payload: {
                jsonrpc: "2.0",
                ...(method !== "notifications/initialized" ? { id: 1 } : {}),
                method,
                ...(method === "initialize"
                  ? {
                      params: {
                        protocolVersion: "2025-03-26",
                        capabilities: {},
                        clientInfo: { name: "runtime-test", version: "1" },
                      },
                    }
                  : {}),
              },
            });
            expect(response.statusCode, response.body).toBe(
              method === "notifications/initialized" ? 202 : 200,
            );
            if (method !== "notifications/initialized") {
              expect(response.json().error, response.body).toBeUndefined();
              if (method === "tools/list")
                expect(response.json().result.tools).toBeInstanceOf(Array);
            }
          }
        }
      }
    });
  }

  test("application runtimes discover tools with OpenAPPA disabled and reject forged bindings", async ({
    makeAgent,
    makeOrganization,
    makeServiceAccount,
  }) => {
    await GuardrailsDeploymentModel.setEnabled(false);
    vi.spyOn(enterpriseTier, "isOpenappaActive").mockReturnValue(false);
    config.openappa.offerSigningSecret = "test-runtime-binding-secret-32chars";
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const account = await makeServiceAccount(org.id);
    const current = await persistBoundRun({
      organizationId: org.id,
      agentId: agent.id,
      actorKind: "serviceAccount",
      actorId: account.id,
    });
    const spec = {
      env: {},
      secretEnv: {} as Record<string, string>,
      activeDeadlineSeconds: 120,
    };
    await stampRuntimeBinding({
      spec,
      organizationId: org.id,
      workspaceId: current.workspace.id,
      taskId: current.task.id,
    });
    const { token: value } = await ServiceAccountModel.createToken({
      serviceAccountId: account.id,
      organizationId: org.id,
      name: "Runtime token",
      expiresIn: 600,
    });
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${value}`,
      [RUNTIME_BINDING_HEADER]: spec.secretEnv[RUNTIME_BINDING_ENV],
      "x-archestra-run-id": current.task.id,
    };
    for (const method of [
      "initialize",
      "tools/list",
      "resources/list",
      "prompts/list",
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/mcp/${agent.id}`,
        headers,
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method,
          ...(method === "initialize"
            ? {
                params: {
                  protocolVersion: "2025-03-26",
                  capabilities: {},
                  clientInfo: { name: "test", version: "1" },
                },
              }
            : {}),
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().error, response.body).toBeUndefined();
    }
    const forged = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: { ...headers, [RUNTIME_BINDING_HEADER]: "forged" },
      payload: { jsonrpc: "2.0", id: 2, method: "tools/list" },
    });
    expect(forged.statusCode).toBe(400);
    const sibling = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: { ...headers, "x-archestra-run-id": crypto.randomUUID() },
      payload: { jsonrpc: "2.0", id: 3, method: "tools/list" },
    });
    expect(sibling.statusCode).toBe(400);
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
    const account = await ServiceAccountModel.create({
      organizationId: org.id,
      name: "team runner",
      role: "member",
      teamId: team.id,
      createdBy: null,
    });
    const secret = "test-offer-signing-secret-32chars";
    config.openappa = { ...config.openappa, offerSigningSecret: secret };
    const first = await persistBoundRun({
      organizationId: org.id,
      agentId: agent.id,
      actorKind: "serviceAccount",
      actorId: account.id,
    });
    const sibling = await persistBoundRun({
      organizationId: org.id,
      agentId: agent.id,
      actorKind: "serviceAccount",
      actorId: account.id,
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
        token: { serviceAccountId: account.id, isOrganizationToken: false },
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
        token: { serviceAccountId: account.id, isOrganizationToken: false },
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
    const { token: accountToken } = await ServiceAccountModel.createToken({
      serviceAccountId: account.id,
      organizationId: org.id,
      name: "Runtime token",
    });
    native.executeRemedyByOffer.mockResolvedValue(
      JSON.stringify({
        decision: "mcp_result",
        offer: { status: "known" },
        result: { content: [{ type: "text", text: "[appa] Authorized." }] },
      }),
    );
    const principal = workloadPrincipal(first.workspace.id);
    const trajectory = currentTrajectory({
      session_id: scopedSessionId(principal, first.workspace.workloadName),
    });
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accountToken}`,
      [RUNTIME_BINDING_HEADER]: wrapped.mcp,
      "x-appa-session-id": first.workspace.workloadName,
      "x-archestra-run-id": first.task.id,
    };
    const payload = {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "archestra__execute_remedy_plan",
        arguments: { offer_id: "offer-stamped", plan: "keep", trajectory },
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
  actorKind: AgentRunActorKind;
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
    actorKind: AgentRunActorKind;
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
    "../docker_images/agent/bin/archestra-claude-code",
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
