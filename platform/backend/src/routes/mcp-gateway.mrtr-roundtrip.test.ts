/**
 * MRTR round trip through the real tool-call handler.
 *
 * The unit tests cover request-state security in isolation; this covers the
 * seam between them — an upstream server elicits, the gateway answers with an
 * InputRequiredResult, and the client's retry carrying that answer completes
 * the call. Driving the actual handler is the point: the elicitation callback
 * is invoked several frames below it, and the signal has to unwind all the way
 * up without being swallowed by the error handling in between.
 */

import crypto from "node:crypto";
import { OAUTH_TOKEN_ID_PREFIX } from "@archestra/shared";
import { vi } from "vitest";
import mcpClient from "@/clients/mcp-client";
import { afterEach, describe, expect, test } from "@/test";
import {
  deriveStatePrincipal,
  GATEWAY_INPUT_REQUEST_KEY,
  verifyRequestState,
} from "./mcp-gateway.mrtr";
import { createAgentServer } from "./mcp-gateway.utils";

type CallToolHandler = (
  request: unknown,
  extra: unknown,
) => Promise<Record<string, unknown>>;

const TOOL_NAME = "bug_tracker__open";

const ELICIT_REQUEST = {
  method: "elicitation/create" as const,
  params: {
    mode: "form",
    message: "Which project?",
    requestedSchema: {
      type: "object",
      properties: { project: { type: "string" } },
      required: ["project"],
    },
  },
};

const ELICIT_ANSWER = { action: "accept", content: { project: "apollo" } };

function getCallToolHandler(server: { server: unknown }): CallToolHandler {
  const handler = (
    server.server as {
      _requestHandlers: Map<string, CallToolHandler>;
    }
  )._requestHandlers.get("tools/call");
  if (!handler) throw new Error("tools/call handler not registered");
  return handler;
}

function callToolRequest() {
  return {
    method: "tools/call",
    params: { name: TOOL_NAME, arguments: {} },
  };
}

describe("MRTR round trip", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function seed({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeTool,
    makeMcpServer,
    makeAgentTool,
  }: Record<string, (...args: never[]) => Promise<Record<string, string>>>) {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(
      user.id as never,
      org.id as never,
      {
        role: "admin",
      } as never,
    );
    const agent = await makeAgent({
      organizationId: org.id,
      accessAllTools: true,
    } as never);
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      name: "bug-tracker",
    } as never);
    const tool = await makeTool({
      catalogId: catalog.id,
      name: TOOL_NAME,
      parameters: { type: "object", properties: {} },
    } as never);
    await makeMcpServer({ catalogId: catalog.id, scope: "org" } as never);
    await makeAgentTool(agent.id as never, tool.id as never);

    const tokenAuth = {
      tokenId: `${OAUTH_TOKEN_ID_PREFIX}${crypto.randomUUID()}`,
      teamId: null,
      isOrganizationToken: false,
      organizationId: org.id,
      isUserToken: true,
      userId: user.id,
    };

    return { org, user, agent, tokenAuth };
  }

  /**
   * Stand in for an upstream server that elicits: invoke the elicitation
   * callback the gateway supplied, and return whatever it yields.
   */
  function upstreamThatElicits() {
    return vi
      .spyOn(mcpClient, "executeToolCallForOwner")
      .mockImplementation(async (toolCall, _owner, _auth, options) => {
        const answer = await (
          options as {
            elicitationHandler?: (r: unknown) => Promise<unknown>;
          }
        ).elicitationHandler?.(ELICIT_REQUEST);

        return {
          id: (toolCall as { id: string }).id,
          name: TOOL_NAME,
          content: [
            { type: "text", text: `answered: ${JSON.stringify(answer)}` },
          ],
          isError: false,
        } as never;
      });
  }

  test("an upstream elicitation becomes an InputRequiredResult the client can act on", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeTool,
    makeMcpServer,
    makeAgentTool,
  }) => {
    const { agent, tokenAuth } = await seed({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeInternalMcpCatalog,
      makeTool,
      makeMcpServer,
      makeAgentTool,
    } as never);
    upstreamThatElicits();

    const { server } = await createAgentServer({
      agentId: agent.id,
      tokenAuth,
      mrtr: { enabled: true, clientCapabilities: { elicitation: {} } },
    });

    const result = await getCallToolHandler(server)(callToolRequest(), {});

    expect(result.resultType).toBe("input_required");
    const inputRequests = result.inputRequests as Record<string, unknown>;
    expect(inputRequests[GATEWAY_INPUT_REQUEST_KEY]).toMatchObject({
      method: "elicitation/create",
    });

    // The state must actually verify for the caller it was minted for,
    // against the very request that produced it.
    const verified = verifyRequestState({
      state: result.requestState as string,
      principal: deriveStatePrincipal(tokenAuth),
      method: "tools/call",
      requestParams: { name: TOOL_NAME, arguments: {} },
    });
    expect(verified.ok).toBe(true);
  });

  test("the retry carrying the answer completes the call", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeTool,
    makeMcpServer,
    makeAgentTool,
  }) => {
    const { agent, tokenAuth } = await seed({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeInternalMcpCatalog,
      makeTool,
      makeMcpServer,
      makeAgentTool,
    } as never);
    upstreamThatElicits();

    // A retry is an independent request: a fresh server, given the answers the
    // client gathered. Nothing survives from the first attempt.
    const { server } = await createAgentServer({
      agentId: agent.id,
      tokenAuth,
      mrtr: {
        enabled: true,
        clientCapabilities: { elicitation: {} },
        inputResponses: { [GATEWAY_INPUT_REQUEST_KEY]: ELICIT_ANSWER },
      },
    });

    const result = await getCallToolHandler(server)(callToolRequest(), {});

    expect(result.resultType).toBeUndefined();
    expect(result.isError).toBeFalsy();
    // The upstream received the client's answer rather than being asked again.
    expect(JSON.stringify(result.content)).toContain("apollo");
  });

  test("a client that never declared elicitation is not asked for it", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeTool,
    makeMcpServer,
    makeAgentTool,
  }) => {
    const { agent, tokenAuth } = await seed({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeInternalMcpCatalog,
      makeTool,
      makeMcpServer,
      makeAgentTool,
    } as never);
    upstreamThatElicits();

    const { server } = await createAgentServer({
      agentId: agent.id,
      tokenAuth,
      mrtr: { enabled: true, clientCapabilities: {} },
    });

    const result = await getCallToolHandler(server)(callToolRequest(), {});

    // Asking for a capability the client never declared is forbidden, so the
    // call fails with something the model can act on instead.
    expect(result.resultType).toBeUndefined();
    expect(result.isError).toBe(true);
  });

  test("a legacy client keeps the in-band elicitation path", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeTool,
    makeMcpServer,
    makeAgentTool,
  }) => {
    const { agent, tokenAuth } = await seed({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeInternalMcpCatalog,
      makeTool,
      makeMcpServer,
      makeAgentTool,
    } as never);
    upstreamThatElicits();

    const { server } = await createAgentServer({
      agentId: agent.id,
      tokenAuth,
      mrtr: { enabled: false },
    });

    // With MRTR off the handler sends the elicitation to the client in-band,
    // exactly as before this feature existed.
    const sendRequest = vi.fn().mockResolvedValue(ELICIT_ANSWER);
    const result = await getCallToolHandler(server)(callToolRequest(), {
      sendRequest,
    });

    expect(sendRequest).toHaveBeenCalled();
    expect(result.resultType).toBeUndefined();
  });
});
