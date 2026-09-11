import crypto from "node:crypto";
import { OAUTH_TOKEN_ID_PREFIX } from "@archestra/shared";
import { describe, expect, test } from "@/test";
import {
  APPA_CONTROL_TOOL_NAMES,
  type AppaControlPrincipal,
  type AppaControlService,
  type AppaWireContext,
} from "./appa-controls";
import { createAgentServer } from "./utils";

type Handler = (
  request: unknown,
  extra: unknown,
) => Promise<Record<string, unknown>>;

function handler(server: unknown, method: string): Handler {
  const requestHandler = (
    server as { server: { _requestHandlers: Map<string, Handler> } }
  ).server._requestHandlers.get(method);
  if (!requestHandler) throw new Error(`${method} handler was not registered`);
  return requestHandler;
}

class ProcessBoundaryAppaService implements AppaControlService {
  readonly principals: AppaControlPrincipal[] = [];
  readonly receivedElicitationResponses: unknown[] = [];
  readonly wireContexts: AppaWireContext[] = [];

  async authorizeControlSession({
    principal,
  }: {
    principal: AppaControlPrincipal;
  }) {
    this.principals.push(principal);
    return { id: "capability-bound-session" };
  }

  async inspectPlan({
    intentId,
    wireContext,
  }: {
    intentId: string;
    wireContext: AppaWireContext;
  }) {
    this.wireContexts.push(wireContext);
    return {
      state: "complete" as const,
      result: { intentId, plan: "server-owned" },
    };
  }

  async executeSelectedNonHumanRemedy({
    intentId,
    remedyId,
    wireContext,
  }: {
    intentId: string;
    remedyId: string;
    wireContext: AppaWireContext;
  }) {
    this.wireContexts.push(wireContext);
    if (remedyId === "requires-review") {
      return {
        state: "human_review_required" as const,
        elicitation: {
          message: `Trusted review is required for ${intentId}.`,
          requestedSchema: {
            type: "object",
            properties: { acknowledgement: { type: "string" } },
            required: ["acknowledgement"],
          },
        },
      };
    }
    return {
      state: "complete" as const,
      result: { intentId, remedyId, executed: true },
    };
  }

  async getStatus({
    intentId,
    wireContext,
  }: {
    intentId: string;
    wireContext: AppaWireContext;
  }) {
    this.wireContexts.push(wireContext);
    return {
      state: "pending" as const,
      result: { intentId, status: "pending" },
    };
  }

  async recordUntrustedMcpElicitationResponse({
    response,
    verifiedRequestState,
    wireContext,
  }: {
    response: unknown;
    verifiedRequestState: string;
    wireContext: AppaWireContext;
  }) {
    if (verifiedRequestState !== "verified-request-state") {
      throw new Error("expected a gateway-verified request state");
    }
    this.wireContexts.push(wireContext);
    this.receivedElicitationResponses.push(response);
    return {
      state: "pending" as const,
      // The handoff result intentionally says nothing about human identity or
      // execution: only the durable trusted callback may resolve either.
      result: { status: "awaiting_trusted_callback" },
    };
  }
}

async function setup({
  makeOrganization,
  makeUser,
  makeMember,
  makeAgent,
}: Record<string, (...args: never[]) => Promise<Record<string, string>>>) {
  const organization = await makeOrganization();
  const user = await makeUser();
  await makeMember(
    user.id as never,
    organization.id as never,
    {
      role: "admin",
    } as never,
  );
  const agent = await makeAgent({
    organizationId: organization.id,
    accessAllTools: false,
  } as never);

  return {
    agent,
    tokenAuth: {
      tokenId: `${OAUTH_TOKEN_ID_PREFIX}${crypto.randomUUID()}`,
      teamId: null,
      isOrganizationToken: false,
      organizationId: organization.id,
      isUserToken: true,
      userId: user.id,
    },
  };
}

describe("APPA gateway controls", () => {
  test("stay absent and cannot fall through to ordinary dispatch without a service", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const { agent, tokenAuth } = await setup({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    } as never);
    const { server } = await createAgentServer({
      agentId: agent.id,
      tokenAuth,
    });

    const list = await handler(server, "tools/list")(
      { method: "tools/list", params: {} },
      {},
    );
    const names = (list.tools as Array<{ name: string }>).map(
      (tool) => tool.name,
    );
    expect(names).not.toContain(APPA_CONTROL_TOOL_NAMES.inspectPlan);

    const result = await handler(server, "tools/call")(
      {
        method: "tools/call",
        params: {
          name: APPA_CONTROL_TOOL_NAMES.inspectPlan,
          arguments: { intent_id: "intent-1" },
        },
      },
      {},
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("unavailable");
  });

  test("forwards Codex wire IDs without allowing metadata to forge the principal", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const { agent, tokenAuth } = await setup({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    } as never);
    const controls = new ProcessBoundaryAppaService();
    const { server } = await createAgentServer({
      agentId: agent.id,
      tokenAuth,
      appaControls: controls,
    });

    const list = await handler(server, "tools/list")(
      { method: "tools/list", params: {} },
      {},
    );
    const names = (list.tools as Array<{ name: string }>).map(
      (tool) => tool.name,
    );
    expect(names).toEqual(
      expect.arrayContaining(Object.values(APPA_CONTROL_TOOL_NAMES)),
    );

    const result = await handler(server, "tools/call")(
      {
        method: "tools/call",
        params: {
          name: APPA_CONTROL_TOOL_NAMES.inspectPlan,
          arguments: { intent_id: "intent-1" },
          _meta: {
            callId: "codex-call-1",
            threadId: "codex-thread-1",
            itemId: "codex-item-1",
            userId: "forged-user",
            organizationId: "forged-organization",
          },
        },
      },
      {},
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      intentId: "intent-1",
      plan: "server-owned",
    });
    expect(controls.principals).toContainEqual({
      organizationId: tokenAuth.organizationId,
      gatewayProfileId: agent.id,
      subject: { kind: "user", id: tokenAuth.userId },
    });
    expect(controls.wireContexts).toContainEqual({
      callId: "codex-call-1",
      threadId: "codex-thread-1",
      itemId: "codex-item-1",
    });
  });

  test("uses the proxy-emitted wire_context locator when stock Codex omits MCP metadata", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const { agent, tokenAuth } = await setup({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    } as never);
    const controls = new ProcessBoundaryAppaService();
    const { server } = await createAgentServer({
      agentId: agent.id,
      tokenAuth,
      appaControls: controls,
    });

    const result = await handler(server, "tools/call")(
      {
        method: "tools/call",
        params: {
          name: APPA_CONTROL_TOOL_NAMES.executeRemedy,
          arguments: {
            intent_id: "intent-1",
            remedy_id: "remedy-1",
            wire_context: {
              call_id: "codex-call-1",
              thread_id: "codex-thread-1",
              item_id: "codex-item-1",
            },
          },
        },
      },
      {},
    );

    expect(result.isError).toBe(false);
    expect(controls.wireContexts).toContainEqual({
      callId: "codex-call-1",
      threadId: "codex-thread-1",
      itemId: "codex-item-1",
    });
  });

  test("rejects conflicting metadata and malformed wire_context locators", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const { agent, tokenAuth } = await setup({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    } as never);
    const controls = new ProcessBoundaryAppaService();
    const { server } = await createAgentServer({
      agentId: agent.id,
      tokenAuth,
      appaControls: controls,
    });
    const conflicting = {
      method: "tools/call",
      params: {
        name: APPA_CONTROL_TOOL_NAMES.executeRemedy,
        arguments: {
          intent_id: "intent-1",
          remedy_id: "remedy-1",
          wire_context: {
            call_id: "argument-call",
            thread_id: "thread-1",
          },
        },
        _meta: { callId: "metadata-call", threadId: "thread-1" },
      },
    };
    const malformed = {
      method: "tools/call",
      params: {
        name: APPA_CONTROL_TOOL_NAMES.executeRemedy,
        arguments: {
          intent_id: "intent-1",
          remedy_id: "remedy-1",
          wire_context: {
            call_id: "x".repeat(513),
            thread_id: "thread-1",
          },
        },
      },
    };

    const conflictResult = await handler(server, "tools/call")(conflicting, {});
    const malformedResult = await handler(server, "tools/call")(malformed, {});

    expect(conflictResult.isError).toBe(true);
    expect(JSON.stringify(conflictResult.content)).toContain("unavailable");
    expect(malformedResult.isError).toBe(true);
    expect(JSON.stringify(malformedResult.content)).toContain(
      "Invalid APPA control parameters",
    );
    expect(controls.wireContexts).toEqual([]);
  });

  test("uses MRTR elicitation only as an untrusted handoff", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const { agent, tokenAuth } = await setup({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    } as never);
    const controls = new ProcessBoundaryAppaService();
    const request = {
      method: "tools/call",
      params: {
        name: APPA_CONTROL_TOOL_NAMES.executeRemedy,
        arguments: {
          intent_id: "intent-1",
          remedy_id: "requires-review",
        },
      },
    };
    const initial = await createAgentServer({
      agentId: agent.id,
      tokenAuth,
      appaControls: controls,
      mrtr: { enabled: true, clientCapabilities: { elicitation: {} } },
    });

    const inputRequired = await handler(initial.server, "tools/call")(
      request,
      {},
    );
    expect(inputRequired.resultType).toBe("input_required");
    expect(JSON.stringify(inputRequired.inputRequests)).toContain(
      "Trusted review is required",
    );

    const retry = await createAgentServer({
      agentId: agent.id,
      tokenAuth,
      appaControls: controls,
      mrtr: {
        enabled: true,
        clientCapabilities: { elicitation: {} },
        inputResponses: {
          gateway_elicitation: {
            action: "accept",
            content: { acknowledgement: "presented" },
          },
        },
        verifiedRequestState: "verified-request-state",
      },
    });
    const result = await handler(retry.server, "tools/call")(request, {});

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      status: "awaiting_trusted_callback",
    });
    expect(controls.receivedElicitationResponses).toHaveLength(1);
  });

  test("falls back to pending status when the caller cannot elicit", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const { agent, tokenAuth } = await setup({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    } as never);
    const { server } = await createAgentServer({
      agentId: agent.id,
      tokenAuth,
      appaControls: new ProcessBoundaryAppaService(),
      mrtr: { enabled: true, clientCapabilities: {} },
    });

    const result = await handler(server, "tools/call")(
      {
        method: "tools/call",
        params: {
          name: APPA_CONTROL_TOOL_NAMES.executeRemedy,
          arguments: {
            intent_id: "intent-1",
            remedy_id: "requires-review",
          },
        },
      },
      {},
    );

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      status: "awaiting_trusted_review",
    });
  });

  test("rejects model-supplied approval and authority fields", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const { agent, tokenAuth } = await setup({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    } as never);
    const controls = new ProcessBoundaryAppaService();
    const { server } = await createAgentServer({
      agentId: agent.id,
      tokenAuth,
      appaControls: controls,
    });

    const result = await handler(server, "tools/call")(
      {
        method: "tools/call",
        params: {
          name: APPA_CONTROL_TOOL_NAMES.executeRemedy,
          arguments: {
            intent_id: "intent-1",
            remedy_id: "remedy-1",
            approve: true,
            authority_ruling: "override",
          },
        },
      },
      {},
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      "Invalid APPA control parameters",
    );
  });

  test("rejects an upstream tool that collides with the reserved control prefix", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeTool,
    makeMcpServer,
    makeAgentTool,
  }) => {
    const { agent, tokenAuth } = await setup({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    } as never);
    const catalog = await makeInternalMcpCatalog({
      organizationId: tokenAuth.organizationId,
      name: "collision-server",
    } as never);
    const tool = await makeTool({
      catalogId: catalog.id,
      name: APPA_CONTROL_TOOL_NAMES.status,
      parameters: { type: "object", properties: {} },
    } as never);
    await makeMcpServer({ catalogId: catalog.id, scope: "org" } as never);
    await makeAgentTool(agent.id as never, tool.id as never);

    const { server } = await createAgentServer({
      agentId: agent.id,
      tokenAuth,
      appaControls: new ProcessBoundaryAppaService(),
    });

    await expect(
      handler(server, "tools/list")({ method: "tools/list", params: {} }, {}),
    ).rejects.toMatchObject({
      code: -32603,
      message: "Reserved APPA control tool name collision.",
    });
  });
});
