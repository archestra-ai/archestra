// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  CLAUDE_CODE_CLIENT_ID,
  extractMcpHumanRuling,
  MCP_HUMAN_RULING_META_KEY,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
  TOOL_GET_REMEDY_PLANS_SHORT_NAME,
} from "@archestra/shared";
import { vi } from "vitest";
import config from "@/config";
import ToolModel from "@/models/tool";
import ToolObservationModel from "@/models/tool-observation";
import { scopedSessionId } from "@/openappa/actor";
import { openappaBatteriesService } from "@/openappa/batteries";
import { currentTrajectory } from "@/openappa/current-trajectory";
import { openappaDeclarations } from "@/openappa/declarations";
import {
  consumeHitlRuling,
  getHitlAskUserArguments,
  getHitlReviewResult,
  recordHitlRuling,
  stageHitlReview,
} from "@/openappa/hitl-review";
import { signPeerProof } from "@/openappa/peer-claims";
import { toolEntries } from "@/openappa/policy-text";
import * as openappaService from "@/openappa/service";
import { workloadPrincipal } from "@/services/agent-runtime/runtime-identity";
import * as guardrailsDeployment from "@/services/guardrails-deployment";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { seedCoverage } from "@/test/openappa-coverage";
import type { Agent } from "@/types";
import {
  type ArchestraContext,
  executeArchestraTool,
  getAllArchestraMcpTools,
} from ".";

// The real cache, stored in this file's test database.
setupTestCacheManager();

const TEST_SIGNING_SECRET = "test-offer-signing-secret-32chars";

function trajectory(session: { session_id?: string; parent_id?: string } = {}) {
  return currentTrajectory({
    session_id: session.session_id ?? "session-1",
    ...(session.parent_id ? { parent_id: session.parent_id } : {}),
  });
}

// todo_write requires an integer id on every item, so the executor refuses
// this call whether or not anyone approves it.
const TODO_WITHOUT_ID = JSON.stringify({
  todos: [{ content: "qa-hitl", status: "pending" }],
});
const VALID_TODO = JSON.stringify({
  todos: [{ id: 1, content: "qa-hitl", status: "pending" }],
});

test("remedy tools open human review without asking for prior consent", () => {
  const tools = getAllArchestraMcpTools();
  const getPlans = tools.find((tool) =>
    tool.name.endsWith(TOOL_GET_REMEDY_PLANS_SHORT_NAME),
  );
  const executePlan = tools.find((tool) =>
    tool.name.endsWith(TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME),
  );

  expect(getPlans?.description).toContain(
    "execute_remedy_plan asks the user for approval when the policy requires it",
  );
  expect(getPlans?.description).not.toContain("use ask_user");
  expect(executePlan?.description).toContain("the result is review_required");
  expect(executePlan?.description).toContain(
    "Ask the user with the declared ask_user tool",
  );
  expect(executePlan?.description).not.toContain(
    "review it before approving the call",
  );
  // Both say who decides instead of telling the model to skip the user.
  for (const description of [getPlans?.description, executePlan?.description]) {
    expect(description).not.toContain("Do not ask the user");
    expect(description).not.toMatch(/immediately/i);
  }
});

test("remedy tools advertise only the arguments the model writes", () => {
  const tools = getAllArchestraMcpTools();
  const getPlans = tools.find((tool) =>
    tool.name.endsWith(TOOL_GET_REMEDY_PLANS_SHORT_NAME),
  );
  const executePlan = tools.find((tool) =>
    tool.name.endsWith(TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME),
  );

  expect(Object.keys(executePlan?.inputSchema.properties ?? {}).sort()).toEqual(
    ["label", "offer_id", "plan", "return_schema"],
  );
  expect(Object.keys(getPlans?.inputSchema.properties ?? {})).not.toContain(
    "offers",
  );
  for (const tool of [getPlans, executePlan]) {
    // A client that forwards the tool list never shows its model the signed
    // members the proxy stamps.
    expect(JSON.stringify(tool?.inputSchema)).not.toMatch(
      /JWS|RFC 7515|signature/,
    );
    // Not strict: a validating client must still accept a stamped call.
    expect(
      (tool?.inputSchema as { additionalProperties?: unknown })
        .additionalProperties,
    ).not.toBe(false);
  }
});

test("policy reads advertise a read-only annotation but policy writes do not", () => {
  const tools = getAllArchestraMcpTools();
  expect(
    tools.find((tool) => tool.name.endsWith("__get_guardrails_policy"))
      ?.annotations,
  ).toMatchObject({ readOnlyHint: true });
  expect(
    tools.find((tool) => tool.name.endsWith("__update_guardrails_policy"))
      ?.annotations?.readOnlyHint,
  ).not.toBe(true);
});

test("peer inbox tools hide transport proofs without rejecting proxy-stamped calls", () => {
  const tools = getAllArchestraMcpTools();
  const list = tools.find((tool) => tool.name.endsWith("list_peer_messages"));
  const read = tools.find((tool) => tool.name.endsWith("read_peer_message"));

  expect(Object.keys(list?.inputSchema.properties ?? {})).toEqual([]);
  expect(Object.keys(read?.inputSchema.properties ?? {})).toEqual([
    "message_id",
  ]);
  for (const tool of [list, read]) {
    expect(tool).toBeDefined();
    expect(JSON.stringify(tool?.inputSchema)).not.toContain("peer_proof");
    expect(tool?.inputSchema.additionalProperties).not.toBe(false);
  }
});

describe("OpenAPPA tool execution", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;
  let orgId: string;
  const toolFullName = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME}`;
  const originalOpenappaConfig = { ...config.openappa };

  beforeEach(
    async ({
      makeAgent,
      makeUser,
      makeOrganization,
      makeMember,
      seedAndAssignArchestraTools,
    }) => {
      config.openappa = {
        enabled: true,
        yellEnabled: false,
        offerSigningSecret: TEST_SIGNING_SECRET,
        postgresMaxConnections: 10,
      };
      vi.spyOn(guardrailsDeployment, "isGuardrailsV2Active").mockResolvedValue(
        true,
      );
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "admin" });
      testAgent = await makeAgent({
        name: "Test Agent",
        organizationId: org.id,
      });
      await seedAndAssignArchestraTools(testAgent.id);
      orgId = org.id;
      mockContext = {
        agent: { id: testAgent.id, name: testAgent.name },
        userId: user.id,
        organizationId: org.id,
      };
    },
  );

  afterEach(() => {
    config.openappa = originalOpenappaConfig;
    vi.restoreAllMocks();
  });

  function peerProof(
    overrides: Partial<Parameters<typeof signPeerProof>[0]> = {},
  ) {
    const proof = signPeerProof(
      {
        v: 1,
        organization_id: orgId,
        caller_id: `user:${mockContext.userId}`,
        session_id: "session-1:worker",
        parent_id: "session-1",
        call_id: "peer-call-1",
        action: "read_peer_message",
        message_id: "message-1",
        ...overrides,
      },
      TEST_SIGNING_SECRET,
    );
    if (!proof) throw new Error("Invalid peer-proof fixture");
    return proof;
  }

  test.each([
    "list_peer_messages",
    "read_peer_message",
  ] as const)("%s refuses to infer an inbox from an ordinary session ID", async (shortName) => {
    await expect(
      executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${shortName}`,
        shortName === "read_peer_message" ? { message_id: "message-1" } : {},
        {
          ...mockContext,
          sessionId: "guessed-session",
          currentToolCallId: "call-1",
        },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test.each([
    "list_peer_messages",
    "read_peer_message",
  ] as const)("%s cannot use inherited session headers when its proof is omitted", async (shortName) => {
    const list = vi.spyOn(openappaService, "listPeerMessages");
    const read = vi.spyOn(openappaService, "readPeerMessage");
    await expect(
      executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${shortName}`,
        shortName === "read_peer_message" ? { message_id: "message-1" } : {},
        {
          ...mockContext,
          openappaSession: { organization_id: orgId, session_id: "session-1" },
          currentToolCallId: "inherited-call",
        },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(list).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  test("a signed proof from one organization cannot read another organization's inbox", async ({
    makeOrganization,
    makeMember,
  }) => {
    const otherOrganization = await makeOrganization();
    const userId = mockContext.userId;
    if (!userId) throw new Error("Missing authenticated fixture user");
    await makeMember(userId, otherOrganization.id, { role: "admin" });
    const read = vi.spyOn(openappaService, "readPeerMessage");

    await expect(
      executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}read_peer_message`,
        { message_id: "message-1", peer_proof: peerProof() },
        {
          ...mockContext,
          organizationId: otherOrganization.id,
          openappaSession: {
            organization_id: otherOrganization.id,
            session_id: "other-session",
          },
        },
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(read).not.toHaveBeenCalled();
  });

  test("listing held messages does not expose content digests or sender-supplied identities", async () => {
    const session = {
      organization_id: orgId,
      caller_id: `user:${mockContext.userId}`,
      session_id: "session-1:worker",
      parent_id: "session-1",
    };
    const list = vi
      .spyOn(openappaService, "listPeerMessages")
      .mockResolvedValue([
        {
          messageId: "message-1",
          senderSessionId: "private-sender-name",
          recipientSessionId: "session-1",
          digest: "private-content-digest",
          expiresAt: "2026-10-04T00:00:00.000Z",
        },
      ]);
    const response = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}list_peer_messages`,
      {
        peer_proof: peerProof({
          action: "list_peer_messages",
          message_id: null,
        }),
      },
      { ...mockContext, openappaSession: session },
    );
    expect(list).toHaveBeenCalledExactlyOnceWith({
      session,
      toolCallId: "peer-call-1",
    });
    expect(response.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          messages: [
            { message_id: "message-1", expires_at: "2026-10-04T00:00:00.000Z" },
          ],
        }),
      },
    ]);
  });

  test("a workload principal can read its own peer proof and not a user's", async () => {
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const principal = workloadPrincipal(workspaceId);
    const read = vi
      .spyOn(openappaService, "readPeerMessage")
      .mockResolvedValue({
        content: [{ type: "text", text: "held" }],
      });
    const context = {
      agent: mockContext.agent,
      organizationId: orgId,
      openappaSession: {
        organization_id: orgId,
        caller_id: principal,
        session_id: `${principal}|workspace-a`,
      },
    };

    await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}read_peer_message`,
      {
        message_id: "message-1",
        peer_proof: peerProof({ caller_id: principal }),
      },
      context,
    );
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ caller_id: principal }),
      }),
    );

    await expect(
      executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}read_peer_message`,
        { message_id: "message-1", peer_proof: peerProof() },
        context,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  test("a peer read cannot supply its own recipient or source label", async () => {
    const read = vi.spyOn(openappaService, "readPeerMessage");
    const response = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}read_peer_message`,
      {
        message_id: "message-1",
        peer_proof: peerProof(),
        session_id: "another-session",
        label: { trust: "trusted", audience: ["public"] },
      },
      {
        ...mockContext,
        currentToolCallId: "read-1",
        openappaSession: { organization_id: orgId, session_id: "session-1" },
      },
    );
    expect(response.isError).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });

  test("a peer read keeps the authenticated child and logical call identity", async () => {
    const session = {
      organization_id: orgId,
      caller_id: `user:${mockContext.userId}`,
      session_id: "session-1:worker",
      parent_id: "session-1",
    };
    const admitted = {
      content: [{ type: "text" as const, text: "A checked peer message" }],
    };
    const read = vi
      .spyOn(openappaService, "readPeerMessage")
      .mockResolvedValue(admitted);
    const response = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}read_peer_message`,
      { message_id: "message-1", peer_proof: peerProof({ call_id: "read-1" }) },
      { ...mockContext, openappaSession: session, currentToolCallId: "read-1" },
    );
    expect(response).toEqual(admitted);
    expect(read).toHaveBeenCalledExactlyOnceWith({
      session,
      toolCallId: "read-1",
      args: { message_id: "message-1" },
    });
  });

  test.each([
    false,
    true,
  ])("a signed read routes to its child without depending on inherited headers (%s)", async (withParentHeaders) => {
    const read = vi
      .spyOn(openappaService, "readPeerMessage")
      .mockResolvedValue({
        content: [{ type: "text", text: "Checked value" }],
      });
    await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}read_peer_message`,
      { message_id: "message-1", peer_proof: peerProof() },
      {
        ...mockContext,
        ...(withParentHeaders
          ? {
              openappaSession: {
                organization_id: orgId,
                session_id: "session-1",
              },
              currentToolCallId: "parent-call",
            }
          : {}),
      },
    );
    expect(read).toHaveBeenCalledExactlyOnceWith({
      session: {
        organization_id: orgId,
        caller_id: `user:${mockContext.userId}`,
        session_id: "session-1:worker",
        parent_id: "session-1",
      },
      toolCallId: "peer-call-1",
      args: { message_id: "message-1" },
    });
  });

  test("a signed inbox listing retains its proxy-issued logical call", async () => {
    const list = vi
      .spyOn(openappaService, "listPeerMessages")
      .mockResolvedValue([]);
    await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}list_peer_messages`,
      {
        peer_proof: peerProof({
          action: "list_peer_messages",
          message_id: null,
        }),
      },
      mockContext,
    );
    expect(list).toHaveBeenCalledExactlyOnceWith({
      session: {
        organization_id: orgId,
        caller_id: `user:${mockContext.userId}`,
        session_id: "session-1:worker",
        parent_id: "session-1",
      },
      toolCallId: "peer-call-1",
    });
  });

  test("a denied read returns unsigned offer ids for the verified child", async () => {
    const read = vi
      .spyOn(openappaService, "readPeerMessage")
      .mockResolvedValue({
        isError: true,
        content: [
          {
            type: "text",
            text: "The read requires accepting a narrower return.",
          },
        ],
        structuredContent: {
          decision: "deny_call",
          peer_read_denied: true,
          offers: [{ offer_id: "peer-read-offer" }],
        },
      });
    const response = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}read_peer_message`,
      { message_id: "message-1", peer_proof: peerProof() },
      mockContext,
    );
    expect(response.isError).toBe(true);
    const text = response.content.find((item) => item.type === "text");
    if (text?.type !== "text") throw new Error("Missing denial text");
    const denial = JSON.parse(text.text);
    expect(denial.message).toBe(
      "The read requires accepting a narrower return.",
    );
    expect(denial.offers).toEqual([{ offer_id: "peer-read-offer" }]);
    expect(JSON.stringify(denial.offers)).not.toMatch(
      /protected|payload|signature/,
    );
    expect(read).toHaveBeenCalledExactlyOnceWith({
      session: {
        organization_id: orgId,
        caller_id: `user:${mockContext.userId}`,
        session_id: "session-1:worker",
        parent_id: "session-1",
      },
      toolCallId: "peer-call-1",
      args: { message_id: "message-1" },
    });
  });

  test("successful peer content is not interpreted as a remedy response", async () => {
    const data = {
      content: [
        { type: "text" as const, text: '{"offers":["not-a-policy-offer"]}' },
      ],
      structuredContent: { offers: ["not-a-policy-offer"] },
    };
    vi.spyOn(openappaService, "readPeerMessage").mockResolvedValue(data);
    const response = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}read_peer_message`,
      { message_id: "message-1", peer_proof: peerProof() },
      mockContext,
    );
    expect(response).toEqual(data);
  });

  test.each([
    { name: "caller", claims: { caller_id: "user:another-member" } },
    {
      name: "organization",
      claims: { organization_id: "another-organization" },
    },
    { name: "message", claims: { message_id: "another-message" } },
    {
      name: "action",
      claims: { action: "list_peer_messages", message_id: null },
    },
  ] as const)("a peer proof cannot change the $name boundary", async ({
    claims,
  }) => {
    const read = vi.spyOn(openappaService, "readPeerMessage");
    await expect(
      executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}read_peer_message`,
        { message_id: "message-1", peer_proof: peerProof(claims) },
        mockContext,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(read).not.toHaveBeenCalled();
  });

  test("a tampered proof does not fall back to an otherwise valid session", async () => {
    const read = vi.spyOn(openappaService, "readPeerMessage");
    await expect(
      executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}read_peer_message`,
        {
          message_id: "message-1",
          peer_proof: { ...peerProof(), signature: "invalid" },
        },
        {
          ...mockContext,
          openappaSession: { organization_id: orgId, session_id: "session-1" },
          currentToolCallId: "read-1",
        },
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(read).not.toHaveBeenCalled();
  });

  test("a malformed remedy call is shown the advertised arguments, not the proxy's", async () => {
    const result = await executeArchestraTool(
      toolFullName,
      { plan: "Accept restriction" },
      mockContext,
    );

    expect(result.isError).toBe(true);
    const text = result.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n");
    expect(text).toContain('"offer_id"');
    // The members the proxy stamps never appear in the model's error text.
    for (const member of [
      "execution",
      "trajectory",
      "protected",
      "payload",
      "signature",
    ]) {
      expect(text).not.toContain(`"${member}"`);
    }
  });

  test("a workload spender executes only its own remedy offer", async () => {
    const workspaceId = "22222222-2222-4222-8222-222222222222";
    const principal = workloadPrincipal(workspaceId);
    const other = workloadPrincipal("33333333-3333-4333-8333-333333333333");
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue(null);
    const executeSpy = vi
      .spyOn(openappaService, "executeRemedyByOffer")
      .mockResolvedValue({
        result: { content: [{ type: "text", text: "Authorized" }] },
        known: true,
      });
    const context = {
      agent: mockContext.agent,
      organizationId: orgId,
      openappaSession: {
        organization_id: orgId,
        caller_id: principal,
        session_id: `${principal}|workspace-a`,
      },
    };
    const owned = {
      trajectory: { v: 1, session_id: `${principal}|workspace-a` },
    };

    const accepted = await executeArchestraTool(
      toolFullName,
      { offer_id: "offer-owned", plan: "keep", ...owned },
      context,
    );
    expect(accepted.isError).toBeFalsy();
    expect(executeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        callerId: principal,
        sessionId: `${principal}|workspace-a`,
      }),
    );

    executeSpy.mockClear();
    const foreign = {
      trajectory: { v: 1, session_id: `${other}|workspace-b` },
    };
    const rejected = await executeArchestraTool(
      toolFullName,
      { offer_id: "offer-foreign", plan: "keep", ...foreign },
      context,
    );
    expect(rejected.isError).toBe(true);
    expect(executeSpy).not.toHaveBeenCalled();

    const stolen = await executeArchestraTool(
      toolFullName,
      { offer_id: "offer-owned", plan: "keep", ...owned },
      mockContext,
    );
    expect(stolen.isError).toBe(true);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  test("executes unreviewed remedy offer immediately without prompting", async () => {
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue(null);
    const executeSpy = vi
      .spyOn(openappaService, "executeRemedyByOffer")
      .mockResolvedValue({
        result: { content: [{ type: "text", text: "Authorized" }] },
        known: true,
      });

    const result = await executeArchestraTool(
      toolFullName,
      {
        ...{ offer_id: "offer-unreviewed", trajectory: trajectory() },
        plan: "Accept restriction",
      },
      mockContext,
    );

    expect(result.isError).toBeFalsy();
    expect(executeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        args: { offer_id: "offer-unreviewed" },
        sessionId: "session-1",
        ruling: undefined,
      }),
    );
  });

  test("a genuine native authority failure is preserved, not relabeled as a failed human review", async () => {
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue(null);
    const nativeResult = {
      content: [
        {
          type: "text" as const,
          text: "[appa] authority reviewer cannot be reached from this session",
        },
      ],
    };
    const executeSpy = vi
      .spyOn(openappaService, "executeRemedyByOffer")
      .mockResolvedValue({
        known: true,
        result: nativeResult,
      });
    const elicitSpy = vi.fn();
    const result = await executeArchestraTool(
      toolFullName,
      { offer_id: "offer-remote", trajectory: trajectory() },
      {
        ...mockContext,
        elicitation: { elicit: elicitSpy },
      },
    );
    expect(result).toEqual(nativeResult);
    expect(executeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ ruling: undefined }),
    );
    expect(elicitSpy).not.toHaveBeenCalled();
    expect(extractMcpHumanRuling(result)).toBeNull();
  });

  test("chat client: prompts user and passes approve ruling", async () => {
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue({
      offer_id: "offer-hitl",
      text: "Approve this email?",
      session_id: "session-1",
      tool: "archestra__todo_write",
      arguments: VALID_TODO,
    });
    const executeSpy = vi
      .spyOn(openappaService, "executeRemedyByOffer")
      .mockResolvedValue({
        result: { content: [{ type: "text", text: "Authorized" }] },
        known: true,
      });

    const elicitSpy = vi.fn().mockResolvedValue({
      status: "answered",
      result: { action: "accept", content: { action: "approve" } },
    });

    const chatContext: ArchestraContext = {
      ...mockContext,
      elicitation: {
        elicit: elicitSpy,
      } as any,
    };

    const result = await executeArchestraTool(
      toolFullName,
      {
        ...{ offer_id: "offer-hitl", trajectory: trajectory() },
        plan: "Human review",
      },
      chatContext,
    );

    expect(elicitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
        message: "Approve this email?",
        kind: "openappa_review",
        reviewedTool: "archestra__todo_write",
        reviewedArguments: VALID_TODO,
      }),
    );
    expect(executeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        args: { offer_id: "offer-hitl" },
        ruling: "approve",
      }),
    );
    expect(executeSpy.mock.calls[0][0]).not.toHaveProperty("precheckRefusal");
    expect(result.content[0]).toEqual({ type: "text", text: "Authorized" });
    expect(extractMcpHumanRuling(result)).toBe("approve");
  });

  test("chat client: a reviewed call that could not run is refused without asking", async () => {
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue({
      offer_id: "offer-hitl",
      text: "Approve this todo?",
      session_id: "session-1",
      tool: "archestra__todo_write",
      arguments: TODO_WITHOUT_ID,
    });
    const executeSpy = vi
      .spyOn(openappaService, "executeRemedyByOffer")
      .mockResolvedValue({
        result: { isError: true, content: [{ type: "text", text: "refused" }] },
        known: true,
      });
    const elicitSpy = vi.fn();

    await executeArchestraTool(
      toolFullName,
      {
        ...{ offer_id: "offer-hitl", trajectory: trajectory() },
        plan: "Human review",
      },
      { ...mockContext, elicitation: { elicit: elicitSpy } as any },
    );

    expect(elicitSpy).not.toHaveBeenCalled();
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const { ruling, precheckRefusal } = executeSpy.mock.calls[0][0];
    expect(ruling).toBeUndefined();
    expect(precheckRefusal).toMatch(
      /^\[appa\] Not submitted for approval: this call to archestra__todo_write could not run even if approved\.\nError: Validation error in archestra__todo_write: .*todos\[0\]\.id/,
    );
    expect(precheckRefusal).toMatch(
      /\nFix the arguments and call archestra__todo_write again; the corrected call gets its own approval\.$/,
    );
  });

  test("a precheck refusal names the reviewed tool and ignores client spelling", async () => {
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue({
      offer_id: "offer-hitl",
      text: "Approve this todo?",
      session_id: "session-1",
      tool: "archestra__todo_write",
      arguments: TODO_WITHOUT_ID,
    });
    const executeSpy = vi
      .spyOn(openappaService, "executeRemedyByOffer")
      .mockResolvedValue({
        result: { isError: true, content: [{ type: "text", text: "refused" }] },
        known: true,
      });

    await executeArchestraTool(
      toolFullName,
      {
        offer_id: "offer-hitl",
        plan: "Human review",
        trajectory: trajectory(),
        spelling: "mcp__archestra__todo_write",
        protected: "e30",
        payload: "{}",
        signature: "sig",
      },
      { ...mockContext, elicitation: { elicit: vi.fn() } as any },
    );

    const { precheckRefusal } = executeSpy.mock.calls[0][0];
    expect(precheckRefusal).toMatch(
      /^\[appa\] Not submitted for approval: this call to archestra__todo_write could not/,
    );
    expect(precheckRefusal).not.toContain("mcp__archestra__todo_write");
    expect(executeSpy.mock.calls[0][0]).not.toHaveProperty("spelling");
  });

  test("chat client: a refusal for a very long executor error stays within the binding's limit", async () => {
    const todos = Array.from({ length: 3000 }, () => ({
      content: "qa-hitl",
      status: "pending",
    }));
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue({
      offer_id: "offer-hitl",
      text: "Approve these todos?",
      session_id: "session-1",
      tool: "archestra__todo_write",
      arguments: JSON.stringify({ todos }),
    });
    const executeSpy = vi
      .spyOn(openappaService, "executeRemedyByOffer")
      .mockResolvedValue({
        result: { isError: true, content: [{ type: "text", text: "refused" }] },
        known: true,
      });

    await executeArchestraTool(
      toolFullName,
      {
        ...{ offer_id: "offer-hitl", trajectory: trajectory() },
        plan: "Human review",
      },
      { ...mockContext, elicitation: { elicit: vi.fn() } as any },
    );

    const { precheckRefusal } = executeSpy.mock.calls[0][0];
    expect(
      Buffer.byteLength(precheckRefusal ?? "", "utf8"),
    ).toBeLessThanOrEqual(64 * 1024);
    expect(precheckRefusal).toMatch(/^\[appa\] Not submitted for approval: /);
    expect(precheckRefusal).toMatch(
      /…\nFix the arguments and call archestra__todo_write again; the corrected call gets its own approval\.$/,
    );
  });

  test("chat client: a caller without the tool's permission is refused with the permission error, not its schema", async ({
    makeMember,
    makeUser,
  }) => {
    const member = await makeUser();
    await makeMember(member.id, orgId, { role: "member" });
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue({
      offer_id: "offer-hitl",
      text: "Approve this team?",
      session_id: "session-1",
      tool: "archestra__create_team",
      arguments: "{}",
    });
    const executeSpy = vi
      .spyOn(openappaService, "executeRemedyByOffer")
      .mockResolvedValue({
        result: { isError: true, content: [{ type: "text", text: "refused" }] },
        known: true,
      });
    const elicitSpy = vi.fn();

    await executeArchestraTool(
      toolFullName,
      {
        ...{ offer_id: "offer-hitl", trajectory: trajectory() },
        plan: "Human review",
      },
      {
        ...mockContext,
        userId: member.id,
        elicitation: { elicit: elicitSpy } as any,
      },
    );

    expect(elicitSpy).not.toHaveBeenCalled();
    const { precheckRefusal } = executeSpy.mock.calls[0][0];
    expect(precheckRefusal).toContain("requires team:create");
    expect(precheckRefusal).not.toContain("Validation error");
    expect(precheckRefusal).not.toContain("shaped like");
  });

  test("chat client: a reviewed call to a tool that is not a built-in is left to the reviewer", async () => {
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue({
      offer_id: "offer-hitl",
      text: "Approve this issue?",
      session_id: "session-1",
      tool: "github__create_issue",
      arguments: "{}",
    });
    const executeSpy = vi
      .spyOn(openappaService, "executeRemedyByOffer")
      .mockResolvedValue({
        result: { content: [{ type: "text", text: "Authorized" }] },
        known: true,
      });
    const elicitSpy = vi.fn().mockResolvedValue({
      status: "answered",
      result: { action: "accept", content: { action: "approve" } },
    });

    await executeArchestraTool(
      toolFullName,
      {
        ...{ offer_id: "offer-hitl", trajectory: trajectory() },
        plan: "Human review",
      },
      { ...mockContext, elicitation: { elicit: elicitSpy } as any },
    );

    expect(elicitSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0][0]).toMatchObject({ ruling: "approve" });
    expect(executeSpy.mock.calls[0][0]).not.toHaveProperty("precheckRefusal");
  });

  test("chat client: user declines passes deny ruling", async () => {
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue({
      offer_id: "offer-hitl",
      text: "Approve this email?",
      session_id: "session-1",
    });
    const executeSpy = vi
      .spyOn(openappaService, "executeRemedyByOffer")
      .mockResolvedValue({
        result: {
          content: [{ type: "text", text: "Declined" }],
          _meta: { trace: "kept" },
        },
        known: true,
      });

    const elicitSpy = vi.fn().mockResolvedValue({
      status: "answered",
      result: { action: "decline" },
    });

    const chatContext: ArchestraContext = {
      ...mockContext,
      elicitation: {
        elicit: elicitSpy,
      } as any,
    };

    const result = await executeArchestraTool(
      toolFullName,
      {
        ...{ offer_id: "offer-hitl", trajectory: trajectory() },
        plan: "Human review",
      },
      chatContext,
    );

    expect(executeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        args: { offer_id: "offer-hitl" },
        ruling: "deny",
      }),
    );
    // The card reads the ruling from _meta; the model reads only the text.
    expect(result.content).toEqual([{ type: "text", text: "Declined" }]);
    expect(result._meta).toEqual({
      trace: "kept",
      [MCP_HUMAN_RULING_META_KEY]: "deny",
    });
  });

  test("chat client: a ruling on an offer the runtime does not know is not shown as given", async () => {
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue({
      offer_id: "offer-hitl",
      text: "Approve this email?",
      session_id: "session-1",
    });
    vi.spyOn(openappaService, "executeRemedyByOffer").mockResolvedValue({
      result: {
        isError: true,
        content: [{ type: "text", text: "[appa] No live offer with this id" }],
      },
      known: false,
    });
    const elicitSpy = vi.fn().mockResolvedValue({
      status: "answered",
      result: { action: "decline" },
    });

    const result = await executeArchestraTool(
      toolFullName,
      {
        ...{ offer_id: "offer-hitl", trajectory: trajectory() },
        plan: "Human review",
      },
      { ...mockContext, elicitation: { elicit: elicitSpy } as any },
    );

    expect(elicitSpy).toHaveBeenCalledTimes(1);
    expect(extractMcpHumanRuling(result)).toBeNull();
  });

  test.each([
    {
      response: { status: "unanswered" },
      outcome: "review_unanswered",
      reason: "timed out without an answer",
    },
    {
      response: { status: "answered", result: { action: "cancel" } },
      outcome: "review_cancelled",
      reason: "canceled the review",
    },
    {
      response: { status: "no_viewer" },
      outcome: "review_unavailable",
      reason: "No human review channel",
    },
    {
      response: { status: "answered", result: { action: "accept" } },
      outcome: "review_invalid",
      reason: "no valid Approve or Deny ruling",
    },
    {
      response: {
        status: "answered",
        result: { action: "accept", content: { action: "unknown" } },
      },
      outcome: "review_invalid",
      reason: "no valid Approve or Deny ruling",
    },
  ] as const)("chat client: $outcome is history, not an authority ruling or unreachable consult", async ({
    response,
    outcome,
    reason,
  }) => {
    const loadSpy = vi
      .spyOn(openappaService, "loadOfferReview")
      .mockResolvedValue({
        offer_id: "offer-hitl",
        text: "Approve this call?",
        session_id: "session-1",
      });
    const executeSpy = vi.spyOn(openappaService, "executeRemedyByOffer");
    const elicitSpy = vi.fn().mockResolvedValue(response);
    const chatContext: ArchestraContext = {
      ...mockContext,
      currentToolCallId: "control-no-answer",
      elicitation: { elicit: elicitSpy },
    };
    const args = {
      offer_id: "offer-hitl",
      trajectory: trajectory(),
      plan: "Human review",
    };
    const result = await executeArchestraTool(toolFullName, args, chatContext);

    expect(elicitSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      ok: false,
      outcome,
      offer_id: "offer-hitl",
    });
    const text = JSON.stringify(result.content);
    expect(text).toContain(reason);
    expect(text).toContain("remains blocked");
    expect(text).toContain("Independent calls may continue");
    expect(text).not.toMatch(/cannot be reached|Authorized|Denied:/);
    expect(extractMcpHumanRuling(result)).toBeNull();

    const lookup = {
      session: { organization_id: orgId, session_id: "session-1" },
      callId: "control-no-answer",
      offerId: "offer-hitl",
    };
    expect(await getHitlReviewResult(lookup)).toBe(outcome);
    expect(await consumeHitlRuling(lookup)).toBeUndefined();
    expect(
      await getHitlAskUserArguments({
        session: lookup.session,
        offerIds: [lookup.offerId],
      }),
    ).toBeUndefined();
    expect(await recordHitlRuling({ ...lookup, ruling: "approve" })).toBe(
      false,
    );

    // A late approval cannot change this logical execution, even when the
    // live native review has disappeared. Replays do not reopen the question.
    loadSpy.mockResolvedValue(null);
    elicitSpy.mockResolvedValue({
      status: "answered",
      result: { action: "accept", content: { action: "approve" } },
    });
    expect(await executeArchestraTool(toolFullName, args, chatContext)).toEqual(
      result,
    );
    expect(elicitSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(
      await getHitlReviewResult({
        ...lookup,
        session: { ...lookup.session, session_id: "other-run" },
      }),
    ).toBeUndefined();
  });

  test("a reviewed call with no handler stays blocked without an unreachable consult", async () => {
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue({
      offer_id: "offer-hitl",
      text: "Review this call",
      session_id: "session-1",
    });
    const executeSpy = vi.spyOn(openappaService, "executeRemedyByOffer");
    const result = await executeArchestraTool(
      toolFullName,
      { offer_id: "offer-hitl", trajectory: trajectory() },
      mockContext,
    );
    expect(result.structuredContent).toMatchObject({
      ok: false,
      outcome: "review_unavailable",
    });
    expect(executeSpy).not.toHaveBeenCalled();
    expect(extractMcpHumanRuling(result)).toBeNull();
  });

  test.each([
    {
      contextRoot: "chat-root",
      stampedRoot: "chat-root",
      parent: undefined,
      expectedCaller: "chat",
    },
    {
      contextRoot: "other-chat",
      stampedRoot: "chat-root",
      parent: undefined,
      expectedCaller: undefined,
    },
    {
      contextRoot: "chat-root",
      stampedRoot: "chat-root",
      parent: "parent-root",
      expectedCaller: undefined,
    },
    {
      contextRoot: "user:external|run",
      stampedRoot: "user:external|run",
      parent: undefined,
      expectedCaller: "user:external",
    },
  ] as const)("binds failed-review history to the actual caller for $stampedRoot with Chat context $contextRoot", async ({
    contextRoot,
    stampedRoot,
    parent,
    expectedCaller,
  }) => {
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue({
      offer_id: "offer-binding",
      text: "Review this call",
      session_id: stampedRoot,
    });
    const executeSpy = vi.spyOn(openappaService, "executeRemedyByOffer");
    await executeArchestraTool(
      toolFullName,
      {
        offer_id: "offer-binding",
        trajectory: trajectory({
          session_id: stampedRoot,
          ...(parent ? { parent_id: parent } : {}),
        }),
      },
      {
        ...mockContext,
        conversationId: contextRoot,
        currentToolCallId: "control-binding",
        elicitation: {
          elicit: vi.fn().mockResolvedValue({ status: "unanswered" }),
        },
      },
    );
    const caller =
      expectedCaller === "chat" ? `user:${mockContext.userId}` : expectedCaller;
    const lookup = {
      session: {
        organization_id: orgId,
        session_id: stampedRoot,
        ...(caller ? { caller_id: caller } : {}),
        ...(parent ? { parent_id: parent } : {}),
      },
      callId: "control-binding",
      offerId: "offer-binding",
    };
    expect(await getHitlReviewResult(lookup)).toBe("review_unanswered");
    expect(
      await getHitlReviewResult({
        ...lookup,
        session: { ...lookup.session, caller_id: "user:another" },
      }),
    ).toBeUndefined();
    if (caller) {
      const { caller_id: _caller, ...missingCaller } = lookup.session;
      expect(
        await getHitlReviewResult({ ...lookup, session: missingCaller }),
      ).toBeUndefined();
    }
    expect(executeSpy).not.toHaveBeenCalled();
  });

  test("an explicit Deny answer is passed as a ruling, not classified as cancellation", async () => {
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue({
      offer_id: "offer-hitl",
      text: "Review this call",
      session_id: "session-1",
    });
    const executeSpy = vi
      .spyOn(openappaService, "executeRemedyByOffer")
      .mockResolvedValue({
        known: true,
        result: { content: [{ type: "text", text: "Denied" }] },
      });
    const result = await executeArchestraTool(
      toolFullName,
      { offer_id: "offer-hitl", trajectory: trajectory() },
      {
        ...mockContext,
        elicitation: {
          elicit: vi.fn().mockResolvedValue({
            status: "answered",
            result: { action: "accept", content: { action: "deny" } },
          }),
        },
      },
    );
    expect(executeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ ruling: "deny" }),
    );
    expect(extractMcpHumanRuling(result)).toBe("deny");
  });

  test("mcp gateway stages the exact review before requesting native input", async () => {
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue({
      offer_id: "offer-hitl",
      text: "Approve this action?",
      session_id: "session-1",
      tool: "archestra__todo_write",
      arguments: VALID_TODO,
    });

    const gatewayContext: ArchestraContext = {
      ...mockContext,
      currentToolCallId: "review-required-call",
      mrtr: {
        enabled: true,
        clientCapabilities: { elicitation: {} },
      },
    };

    const executeSpy = vi.spyOn(openappaService, "executeRemedyByOffer");
    const result = await executeArchestraTool(
      toolFullName,
      {
        ...{ offer_id: "offer-hitl", trajectory: trajectory() },
        plan: "Review",
      },
      gatewayContext,
    );

    expect(result.structuredContent).toMatchObject({
      outcome: "review_required",
      offer_id: "offer-hitl",
    });
    expect(executeSpy).not.toHaveBeenCalled();
    expect(
      await getHitlReviewResult({
        session: { organization_id: orgId, session_id: "session-1" },
        callId: "review-required-call",
        offerId: "offer-hitl",
      }),
    ).toBe("review_required");
    expect(
      await getHitlAskUserArguments({
        session: {
          organization_id: orgId,
          session_id: "session-1",
        },
        offerIds: ["offer-hitl"],
      }),
    ).toMatchObject({
      question: "Approve this action?",
      remedy_offer_ids: ["offer-hitl"],
    });
  });

  test("mcp gateway MRTR: round 1 refuses a reviewed call that could not run instead of asking", async () => {
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue({
      offer_id: "offer-hitl",
      text: "Approve this todo?",
      session_id: "session-1",
      tool: "archestra__todo_write",
      arguments: TODO_WITHOUT_ID,
    });
    const refusal = {
      isError: true,
      content: [{ type: "text" as const, text: "[appa] Not submitted" }],
    };
    const executeSpy = vi
      .spyOn(openappaService, "executeRemedyByOffer")
      .mockResolvedValue({ result: refusal, known: true });

    const result = await executeArchestraTool(
      toolFullName,
      {
        ...{ offer_id: "offer-hitl", trajectory: trajectory() },
        plan: "Review",
      },
      {
        ...mockContext,
        mrtr: { enabled: true, clientCapabilities: { elicitation: {} } },
      },
    );

    expect(result).toEqual(refusal);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const { ruling, precheckRefusal } = executeSpy.mock.calls[0][0];
    expect(ruling).toBeUndefined();
    expect(precheckRefusal).toMatch(
      /^\[appa\] Not submitted for approval: this call to archestra__todo_write could not run even if approved\.\n.*todos\[0\]\.id/,
    );
  });

  test("mcp gateway consumes a native approval once", async () => {
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue({
      offer_id: "offer-hitl",
      text: "Approve this action?",
      session_id: "session-1",
    });
    const executeSpy = vi
      .spyOn(openappaService, "executeRemedyByOffer")
      .mockResolvedValue({
        result: { content: [{ type: "text", text: "Authorized" }] },
        known: true,
      });

    const gatewayContext: ArchestraContext = {
      ...mockContext,
      mrtr: {
        enabled: true,
        clientCapabilities: { elicitation: {} },
      },
    };
    const session = {
      organization_id: orgId,
      session_id: "session-1",
    };
    await stageHitlReview({
      session,
      review: {
        offerId: "offer-hitl",
        text: "Approve this action?",
      },
    });
    await recordHitlRuling({
      session,
      offerId: "offer-hitl",
      ruling: "approve",
    });

    await executeArchestraTool(
      toolFullName,
      {
        ...{ offer_id: "offer-hitl", trajectory: trajectory() },
        plan: "Review",
      },
      gatewayContext,
    );

    expect(executeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        args: { offer_id: "offer-hitl" },
        ruling: "approve",
      }),
    );
    executeSpy.mockClear();
    await executeArchestraTool(
      toolFullName,
      {
        ...{ offer_id: "offer-hitl", trajectory: trajectory() },
        plan: "Review",
      },
      gatewayContext,
    );
    expect(executeSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ ruling: "approve" }),
    );
  });

  test("mcp gateway without elicitation returns native review instructions promptly", async () => {
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue({
      offer_id: "offer-hitl",
      text: "Approve this action?",
      session_id: "session-1",
    });
    const executeSpy = vi
      .spyOn(openappaService, "executeRemedyByOffer")
      .mockResolvedValue({
        result: { content: [{ type: "text", text: "gave no answer" }] },
        known: true,
      });

    // Codex/OpenCode: no elicitation capability
    const codexContext: ArchestraContext = {
      ...mockContext,
      mrtr: {
        enabled: true,
        clientCapabilities: {},
      },
    };

    const result = await executeArchestraTool(
      toolFullName,
      {
        ...{ offer_id: "offer-hitl", trajectory: trajectory() },
        plan: "Review",
      },
      codexContext,
    );

    expect(result.structuredContent).toMatchObject({
      outcome: "review_required",
      offer_id: "offer-hitl",
    });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  test.each([
    "user:other-account",
    "virtual-key:vk-1",
    "app:app-1",
  ])("an authenticated user can spend a pending review on the same %s trajectory", async (callerId) => {
    const sessionId = scopedSessionId(callerId, "client-session");
    const session = {
      organization_id: orgId,
      caller_id: callerId,
      session_id: sessionId,
    };
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue({
      offer_id: "offer-shared",
      text: "Approve?",
      session_id: sessionId,
    });
    const executeSpy = vi
      .spyOn(openappaService, "executeRemedyByOffer")
      .mockResolvedValue({
        result: { content: [{ type: "text", text: "Authorized" }] },
        known: true,
      });
    await stageHitlReview({
      session,
      review: { offerId: "offer-shared", text: "Approve?" },
    });
    await recordHitlRuling({
      session,
      offerId: "offer-shared",
      ruling: "approve",
    });

    await executeArchestraTool(
      toolFullName,
      {
        offer_id: "offer-shared",
        trajectory: trajectory({ session_id: sessionId }),
        plan: "Review",
      },
      {
        ...mockContext,
        mrtr: { enabled: true, clientCapabilities: { elicitation: {} } },
      },
    );

    expect(executeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: orgId,
        callerId: `user:${mockContext.userId}`,
        sessionId,
        ruling: "approve",
      }),
    );
    const passed = executeSpy.mock.calls[0][0];
    expect(passed).not.toHaveProperty("ownerCallerId");
    expect(passed).not.toHaveProperty("tool");
    expect(passed).not.toHaveProperty("spelling");
    expect(passed).not.toHaveProperty("dispatch");
    expect(
      await consumeHitlRuling({ session, offerId: "offer-shared" }),
    ).toBeUndefined();
  });

  test("a wrong trajectory does not consume a pending review", async () => {
    const session = {
      organization_id: orgId,
      caller_id: "virtual-key:vk-1",
      session_id: scopedSessionId("virtual-key:vk-1", "client-session"),
    };
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue({
      offer_id: "offer-shared",
      text: "Approve?",
      session_id: session.session_id,
    });
    const executeSpy = vi.spyOn(openappaService, "executeRemedyByOffer");
    await stageHitlReview({
      session,
      review: { offerId: "offer-shared", text: "Approve?" },
    });
    await recordHitlRuling({
      session,
      offerId: "offer-shared",
      ruling: "approve",
    });

    const result = await executeArchestraTool(
      toolFullName,
      {
        offer_id: "offer-shared",
        trajectory: trajectory({ session_id: "other-session" }),
        plan: "Review",
      },
      {
        ...mockContext,
        mrtr: { enabled: true, clientCapabilities: { elicitation: {} } },
      },
    );

    expect(result.structuredContent).toMatchObject({
      outcome: "review_required",
    });
    expect(executeSpy).not.toHaveBeenCalled();
    expect(await consumeHitlRuling({ session, offerId: "offer-shared" })).toBe(
      "approve",
    );
  });

  test.each([
    {
      case: "missing",
      args: { offer_id: "offer-shared", plan: "Review" },
    },
    {
      case: "signature-only",
      args: {
        offer_id: "offer-shared",
        plan: "Review",
        protected: "e30",
        payload: "{}",
        signature: "sig",
      },
    },
    {
      case: "malformed",
      args: {
        offer_id: "offer-shared",
        plan: "Review",
        trajectory: { v: 2, session_id: "session-1" },
      },
    },
  ])("a $case trajectory does not consume a pending review", async ({
    args,
  }) => {
    const session = { organization_id: orgId, session_id: "session-1" };
    const loadSpy = vi.spyOn(openappaService, "loadOfferReview");
    const executeSpy = vi.spyOn(openappaService, "executeRemedyByOffer");
    await stageHitlReview({
      session,
      review: { offerId: "offer-shared", text: "Approve?" },
    });
    await recordHitlRuling({
      session,
      offerId: "offer-shared",
      ruling: "approve",
    });

    await executeArchestraTool(toolFullName, args, {
      ...mockContext,
      mrtr: { enabled: true, clientCapabilities: { elicitation: {} } },
    });

    expect(loadSpy).not.toHaveBeenCalled();
    expect(executeSpy).not.toHaveBeenCalled();
    expect(await consumeHitlRuling({ session, offerId: "offer-shared" })).toBe(
      "approve",
    );
  });

  test.each([
    "absent",
    "parent",
    "raw parent",
  ])("child scope comes from the stamp when the gateway session is %s", async (gatewaySession) => {
    const callerId = "virtual-key:vk-1";
    const parentId = scopedSessionId(callerId, "parent-session");
    const childId = `${parentId}:child-agent`;
    const childSession = {
      organization_id: orgId,
      caller_id: callerId,
      session_id: childId,
      parent_id: parentId,
    };
    const headerSession = {
      organization_id: orgId,
      caller_id: `user:${mockContext.userId}`,
      session_id: gatewaySession === "raw parent" ? "parent-session" : parentId,
    };
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue({
      offer_id: "offer-child",
      text: "Approve the child?",
      session_id: childId,
    });
    const executeSpy = vi
      .spyOn(openappaService, "executeRemedyByOffer")
      .mockResolvedValue({
        result: { content: [{ type: "text", text: "Authorized" }] },
        known: true,
      });
    await stageHitlReview({
      session: childSession,
      review: { offerId: "offer-child", text: "Approve the child?" },
    });
    await recordHitlRuling({
      session: childSession,
      offerId: "offer-child",
      ruling: "approve",
    });
    await stageHitlReview({
      session: headerSession,
      review: { offerId: "offer-child", text: "Parent review" },
    });
    await recordHitlRuling({
      session: headerSession,
      offerId: "offer-child",
      ruling: "deny",
    });

    await executeArchestraTool(
      toolFullName,
      {
        offer_id: "offer-child",
        trajectory: trajectory({
          session_id: childId,
          parent_id: parentId,
        }),
        plan: "Review",
      },
      {
        ...mockContext,
        openappaSession:
          gatewaySession === "absent" ? undefined : headerSession,
        mrtr: { enabled: true, clientCapabilities: { elicitation: {} } },
      },
    );

    expect(openappaService.loadOfferReview).toHaveBeenCalledWith({
      organizationId: orgId,
      sessionId: childId,
      offerId: "offer-child",
    });
    expect(executeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: orgId,
        callerId: `user:${mockContext.userId}`,
        sessionId: childId,
        parentId,
        ruling: "approve",
      }),
    );
    expect(
      await consumeHitlRuling({
        session: childSession,
        offerId: "offer-child",
      }),
    ).toBeUndefined();
    expect(
      await consumeHitlRuling({
        session: headerSession,
        offerId: "offer-child",
      }),
    ).toBe("deny");
  });
});

describe("list_detected_mcp_servers", () => {
  const toolFullName = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}list_detected_mcp_servers`;
  const originalOpenappaConfig = { ...config.openappa };
  afterEach(() => {
    config.openappa = originalOpenappaConfig;
  });

  test("lists each client's own servers with the batteries that name their tools, marked once attached", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    config.openappa = { ...originalOpenappaConfig, enabled: true };
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const battery = await openappaDeclarations.resolveInstalled({
      organizationId: org.id,
      name: "github",
      packageHash: null,
    });
    const named = toolEntries(battery?.policy ?? "")
      .map((entry) => /^mcp\/[^/]+\/([^/*][^/]*)$/.exec(entry.name)?.[1])
      .find((name): name is string => name !== undefined);
    if (!named) throw new Error("the github battery names no tool");
    await ToolModel.bulkCreateProxyToolsIfNotExists(
      [
        { name: `mcp__github__${named}`, description: null, parameters: {} },
        { name: "mcp__weather__forecast", description: null, parameters: {} },
      ],
      "",
    );
    await ToolObservationModel.recordObservations({
      toolNames: [`mcp__github__${named}`, "mcp__weather__forecast"],
      userId: user.id,
      externalAgentId: CLAUDE_CODE_CLIENT_ID,
    });
    const context: ArchestraContext = {
      agent: { id: "agent", name: "Agent" },
      userId: user.id,
      organizationId: org.id,
    };

    const result = await executeArchestraTool(toolFullName, {}, context);
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as any).serverCount).toBe(2);
    expect((result.structuredContent as any).servers).toEqual([
      {
        id: "claude-code.github",
        label: "github",
        client: "claude-code",
        toolCount: 1,
        toolNames: [named],
        batteryMatches: [
          {
            battery: "github",
            declared: false,
            include: "batteries/github/appa.toml",
            namespaces: battery?.namespaces,
            credentials: battery?.credentials,
          },
        ],
      },
      {
        id: "claude-code.weather",
        label: "weather",
        client: "claude-code",
        toolCount: 1,
        toolNames: ["forecast"],
        batteryMatches: [],
      },
    ]);
    // One server by id reads only its own observations.
    const one = await executeArchestraTool(
      toolFullName,
      { serverId: "claude-code.weather" },
      context,
    );
    expect(
      (one.structuredContent as any).servers.map((server: any) => server.id),
    ).toEqual(["claude-code.weather"]);
    expect(
      (
        await executeArchestraTool(
          toolFullName,
          { serverId: "codex.weather" },
          context,
        )
      ).structuredContent,
    ).toEqual({ serverCount: 0, servers: [] });
    // An id that is not a detected server's is refused, not reported empty.
    expect(
      (
        await executeArchestraTool(
          toolFullName,
          { serverId: "claude-code.bad__label" },
          context,
        )
      ).isError,
    ).toBe(true);

    await openappaBatteriesService.createInstall({
      userId: user.id,
      organizationId: org.id,
      install: {
        batteryName: "github",
        attachment: { kind: "detected", detectedId: "claude-code.github" },
        packageHash: null,
      },
    });
    const after = await executeArchestraTool(
      toolFullName,
      { serverId: null },
      context,
    );
    expect(
      (after.structuredContent as any).servers[0].batteryMatches.map(
        (match: any) => [match.battery, match.declared],
      ),
    ).toEqual([["github", true]]);
  });

  test("a caller without openappaPolicy:read is refused", async ({
    makeOrganization,
    makeUser,
  }) => {
    config.openappa = { ...originalOpenappaConfig, enabled: true };
    const org = await makeOrganization();
    // Not a member of the organization: no permission on its policy.
    const user = await makeUser();
    const refused = await executeArchestraTool(
      toolFullName,
      {},
      {
        agent: { id: "agent", name: "Agent" },
        userId: user.id,
        organizationId: org.id,
      },
    );
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toBeUndefined();
  });
});

describe("list_guardrails_battery_fits", () => {
  const toolFullName = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}list_guardrails_battery_fits`;
  const originalOpenappaConfig = { ...config.openappa };
  afterEach(() => {
    config.openappa = originalOpenappaConfig;
  });

  const setUp = async (fixtures: {
    makeOrganization: any;
    makeUser: any;
    makeMember: any;
    makeInternalMcpCatalog: any;
    makeTool: any;
    makeAgent: any;
    makeAgentTool: any;
  }) => {
    config.openappa = { ...originalOpenappaConfig, enabled: true };
    const org = await fixtures.makeOrganization();
    const user = await fixtures.makeUser();
    await fixtures.makeMember(user.id, org.id, { role: "admin" });
    const { catalogIds } = await seedCoverage({
      organizationId: org.id,
      userId: user.id,
      fixtures,
    });
    await fixtures.makeTool({
      catalogId: catalogIds.linear,
      name: "linear__get_issue",
      rawName: "get_issue",
    });
    // The bundled linear battery names no such tool.
    await fixtures.makeTool({
      catalogId: catalogIds.linear,
      name: "linear__summon_unicorn",
      rawName: "summon_unicorn",
    });
    const context: ArchestraContext = {
      agent: { id: "agent", name: "Agent" },
      userId: user.id,
      organizationId: org.id,
    };
    return { catalogIds, context };
  };

  const fits = async (args: Record<string, unknown>, context: any) => {
    const result = await executeArchestraTool(toolFullName, args, context);
    expect(result.isError).toBeFalsy();
    return (result.structuredContent as any).fits;
  };

  test("advertises a required nullable server ID for strict tool schemas", () => {
    const tool = getAllArchestraMcpTools().find(
      (candidate) => candidate.name === toolFullName,
    );
    expect(tool?.inputSchema.required).toContain("mcpServerId");
    expect(tool?.inputSchema.properties?.mcpServerId).toMatchObject({
      anyOf: [{ type: "string", format: "uuid" }, { type: "null" }],
    });
  });

  test("says how to declare a battery that fits and what its rules would do", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
    makeTool,
    makeAgent,
    makeAgentTool,
  }) => {
    const { catalogIds, context } = await setUp({
      makeOrganization,
      makeUser,
      makeMember,
      makeInternalMcpCatalog,
      makeTool,
      makeAgent,
      makeAgentTool,
    });

    // Docs and Acme already have their batteries declared, so only Linear fits.
    expect(await fits({ mcpServerId: null }, context)).toEqual([
      expect.objectContaining({
        mcpServerId: catalogIds.linear,
        mcpServerName: "Linear",
        toolPrefixes: ["linear"],
        battery: "linear",
        evidence: "host",
        include: "batteries/linear/appa.toml",
        namespaces: ["linear"],
        credentials: ["APPA_PROVIDER_LINEAR_TOKEN"],
        newlyCovered: 1,
        rules: [
          {
            tool: "linear__get_issue",
            selector: null,
            kind: "write",
            delta: { audience: ["@linear:issue/$id/readers"] },
            requires: { audience: ["internal"] },
            annotator: null,
            currentRule: null,
          },
        ],
      }),
    ]);
  });

  test("narrows to one server", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
    makeTool,
    makeAgent,
    makeAgentTool,
  }) => {
    const { catalogIds, context } = await setUp({
      makeOrganization,
      makeUser,
      makeMember,
      makeInternalMcpCatalog,
      makeTool,
      makeAgent,
      makeAgentTool,
    });

    expect(
      await fits({ mcpServerId: catalogIds.linear }, context),
    ).toHaveLength(1);
    expect(await fits({ mcpServerId: catalogIds.acme }, context)).toEqual([]);
  });

  test("leaves out another member's personal server", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    config.openappa = { ...originalOpenappaConfig, enabled: true };
    const org = await makeOrganization();
    const owner = await makeUser();
    const viewer = await makeUser();
    await makeMember(owner.id, org.id, { role: "member" });
    await makeMember(viewer.id, org.id, { role: "member" });
    const linear = await makeInternalMcpCatalog({
      organizationId: org.id,
      authorId: owner.id,
      access: "personal",
      name: "Linear",
      serverUrl: "https://mcp.linear.app/mcp",
    });
    await makeTool({
      catalogId: linear.id,
      name: "linear__get_issue",
      rawName: "get_issue",
    });
    const context = (userId: string): ArchestraContext => ({
      agent: { id: "agent", name: "Agent" },
      userId,
      organizationId: org.id,
    });

    expect(await fits({ mcpServerId: null }, context(owner.id))).toEqual([
      expect.objectContaining({ mcpServerId: linear.id }),
    ]);
    expect(await fits({ mcpServerId: null }, context(viewer.id))).toEqual([]);
  });
});
