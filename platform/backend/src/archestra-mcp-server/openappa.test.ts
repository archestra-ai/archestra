// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  extractMcpHumanRuling,
  MCP_HUMAN_RULING_META_KEY,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
  TOOL_GET_REMEDY_PLANS_SHORT_NAME,
} from "@archestra/shared";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import { openappaActor } from "@/openappa/actor";
import * as hitlReview from "@/openappa/hitl-review";
import {
  consumeHitlRuling,
  getHitlAskUserArguments,
  getHitlReview,
  recordHitlRuling,
  stageHitlReview,
} from "@/openappa/hitl-review";
import {
  signOfferClaims,
  unsignedOfferClaims,
  verifyOfferClaims,
} from "@/openappa/offer-claims";
import { signPeerProof } from "@/openappa/peer-claims";
import { AppaRewriteReplay } from "@/openappa/rewrite-replay";
import * as openappaService from "@/openappa/service";
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

async function retainControlSession(organizationId: string, callerId?: string) {
  config.secretsManager.encryptionSecret = "openappa-test-replay-secret";
  await db
    .insert(schema.openappaSessionsTable)
    .values({
      actor: openappaActor("session-1"),
      root: `root-${organizationId}`,
      organizationId,
      callerId,
      sessionId: "session-1",
      startDecision: { decision: "ack" },
    })
    .onConflictDoNothing();
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
    "apply that plan with execute_remedy_plan",
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
        rewrite: config.openappa.rewrite,
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
        currentToolCallId: "toolu_test_call",
      };
      await retainControlSession(org.id, `user:${user.id}`);
    },
  );

  afterEach(() => {
    config.openappa = originalOpenappaConfig;
    vi.restoreAllMocks();
  });

  function signedRemedyArgs(
    organizationId: string,
    offerId: string,
    names: { tool?: string; spelling?: string; callerId?: string | null } = {},
  ) {
    const { callerId = `user:${mockContext.userId}`, ...toolNames } = names;
    const jws = signOfferClaims(
      unsignedOfferClaims({
        organizationId,
        sessionId: "session-1",
        callerId: callerId ?? undefined,
        offerId,
        ...toolNames,
      }),
      TEST_SIGNING_SECRET,
    );
    return { offer_id: offerId, ...jws };
  }

  function ownedControlSession() {
    return {
      organization_id: orgId,
      caller_id: `user:${mockContext.userId}`,
      session_id: "session-1",
    };
  }

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

  test("a denied read returns signed remedies scoped to the receiving child", async () => {
    vi.spyOn(openappaService, "readPeerMessage").mockResolvedValue({
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
    expect(denial.offers).toHaveLength(1);
    expect(
      verifyOfferClaims(denial.offers[0], TEST_SIGNING_SECRET),
    ).toMatchObject({
      organization_id: orgId,
      caller_id: `user:${mockContext.userId}`,
      session_id: "session-1:worker",
      parent_id: "session-1",
      offer_id: "peer-read-offer",
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
    for (const member of ["execution", "protected", "payload", "signature"]) {
      expect(text).not.toContain(`"${member}"`);
    }
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
        ...signedRemedyArgs(orgId, "offer-unreviewed"),
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

  test.for([
    false,
    true,
  ])("a wrong spender cannot read, stage, consume, or retain the owner's review (approved=%s)", async (approved, {
    makeUser,
    makeMember,
  }) => {
    const wrongSpender = await makeUser();
    await makeMember(wrongSpender.id, orgId, { role: "admin" });
    const offerId = "offer-personal";
    const session = {
      organization_id: orgId,
      caller_id: `user:${mockContext.userId}`,
      session_id: "session-1",
    };
    const review = {
      offerId,
      text: "Owner's exact review.",
      tool: "archestra__todo_write",
      arguments: VALID_TODO,
    };
    if (approved) {
      await stageHitlReview({ session, review });
      await recordHitlRuling({ session, offerId, ruling: "approve" });
    }
    const load = vi
      .spyOn(openappaService, "loadOfferReview")
      .mockResolvedValue({
        offer_id: offerId,
        session_id: session.session_id,
        text: "Replacement review.",
        tool: review.tool,
        arguments: review.arguments,
      });
    const execute = vi
      .spyOn(openappaService, "executeRemedyByOffer")
      .mockResolvedValue({
        result: { content: [{ type: "text", text: "Authorized" }] },
        known: true,
      });
    const receiptsBefore = await db
      .select()
      .from(schema.openappaRewritePairsTable);
    const groupsBefore = await db
      .select()
      .from(schema.openappaRewriteGroupsTable);
    const elicit = vi.fn();
    const reserve = vi.spyOn(AppaRewriteReplay, "reserveControlOutcome");
    const response = await executeArchestraTool(
      toolFullName,
      { ...signedRemedyArgs(orgId, offerId), plan: "Review" },
      {
        ...mockContext,
        userId: wrongSpender.id,
        currentToolCallId: "wrong-spender-call",
        mrtr: { enabled: true, clientCapabilities: { elicitation: {} } },
        elicitation: { elicit },
      },
    );
    expect(response).toEqual({
      isError: true,
      content: [{ type: "text", text: "[appa] No live offer with this id" }],
    });
    expect(load).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(elicit).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(await getHitlReview({ session, offerId })).toEqual(
      approved ? review : undefined,
    );
    expect(await db.select().from(schema.openappaRewritePairsTable)).toEqual(
      receiptsBefore,
    );
    expect(await db.select().from(schema.openappaRewriteGroupsTable)).toEqual(
      groupsBefore,
    );

    const ownerResponse = await executeArchestraTool(
      toolFullName,
      { ...signedRemedyArgs(orgId, offerId), plan: "Review" },
      {
        ...mockContext,
        currentToolCallId: "owner-headerless-call",
        mrtr: { enabled: true, clientCapabilities: { elicitation: {} } },
      },
    );
    expect(ownerResponse.isError).not.toBe(true);
    if (approved) {
      expect(ownerResponse.content).toEqual([
        { type: "text", text: "Authorized" },
      ]);
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ ruling: "approve" }),
      );
    } else {
      expect(ownerResponse.structuredContent).toMatchObject({
        outcome: "review_required",
        offer_id: offerId,
      });
      expect(execute).not.toHaveBeenCalled();
    }
    expect(load).toHaveBeenCalledWith({
      organizationId: orgId,
      sessionId: session.session_id,
      offerId,
    });
    expect(await consumeHitlRuling({ session, offerId })).toBeUndefined();
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  test.each([
    "app:credential",
    "virtual-key:credential",
    "service:credential",
  ])("preserves native organization-scoped authorization for an owned %s offer", async (ownerCallerId) => {
    await db
      .update(schema.openappaSessionsTable)
      .set({ callerId: ownerCallerId })
      .where(eq(schema.openappaSessionsTable.organizationId, orgId));
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue(null);
    const execute = vi
      .spyOn(openappaService, "executeRemedyByOffer")
      .mockResolvedValue({
        result: { content: [{ type: "text", text: "Authorized" }] },
        known: true,
      });
    const response = await executeArchestraTool(
      toolFullName,
      signedRemedyArgs(orgId, "offer-credential", { callerId: ownerCallerId }),
      mockContext,
    );
    expect(response.isError).not.toBe(true);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        callerId: `user:${mockContext.userId}`,
        ownerCallerId,
        sessionId: "session-1",
      }),
    );
  });

  test.each([
    null,
    "user:",
    "app:",
    "virtual-key:",
  ])("refuses an ownerless or malformed typed offer before review lookup (owner=%s)", async (callerId) => {
    const load = vi
      .spyOn(openappaService, "loadOfferReview")
      .mockResolvedValue(null);
    const execute = vi.spyOn(openappaService, "executeRemedyByOffer");
    const response = await executeArchestraTool(
      toolFullName,
      signedRemedyArgs(orgId, "offer-invalid-owner", { callerId }),
      mockContext,
    );
    expect(response.isError).toBe(true);
    expect(load).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(await db.select().from(schema.openappaRewritePairsTable)).toEqual(
      [],
    );
  });

  test.each([
    "full entry budget",
    "full byte budget",
    "missing call ID",
    "invalid call ID",
    "oversized call ID",
    "conflicting receipt",
    "reserved receipt",
    "redacted context",
    "mismatched execution",
  ] as const)("an approved remedy fails before review or ruling consumption for %s", async (failure) => {
    const session = ownedControlSession();
    const offerId = "offer-approved-preflight";
    const review = {
      offerId,
      text: "Approve this exact call?",
      tool: "archestra__todo_write",
      arguments: VALID_TODO,
    };
    await stageHitlReview({ session, review });
    await recordHitlRuling({ session, offerId, ruling: "approve" });
    if (failure === "full entry budget") {
      config.openappa.rewrite = {
        ...config.openappa.rewrite,
        maxEntries: 1,
      };
    } else if (failure === "full byte budget") {
      config.openappa.rewrite = {
        ...config.openappa.rewrite,
        maxBytes: 1024,
      };
    }
    if (failure === "full entry budget" || failure === "conflicting receipt") {
      await AppaRewriteReplay.storeControlOutcome({
        session,
        toolCallId:
          failure === "conflicting receipt" ? "approved-call" : "another-call",
        outcome: "denied",
        bytes: "An earlier exact result.",
      });
    } else if (failure === "reserved receipt") {
      await AppaRewriteReplay.reserveControlOutcome({
        session,
        toolCallId: "approved-call",
        spenderId: `user:${mockContext.userId}`,
        requestIdentity: "a".repeat(64),
      });
    }
    const pairsBefore = await db
      .select()
      .from(schema.openappaRewritePairsTable);
    const load = vi
      .spyOn(openappaService, "loadOfferReview")
      .mockResolvedValue({
        offer_id: offerId,
        session_id: session.session_id,
        text: review.text,
        tool: review.tool,
        arguments: review.arguments,
      });
    const execute = vi
      .spyOn(openappaService, "executeRemedyByOffer")
      .mockResolvedValue({
        known: true,
        result: { content: [{ type: "text", text: "Authorized" }] },
      });
    const consume = vi.spyOn(hitlReview, "consumeHitlRuling");
    const clear = vi.spyOn(hitlReview, "clearHitlReview");
    const stage = vi.spyOn(hitlReview, "stageHitlReview");
    const args = { ...signedRemedyArgs(orgId, offerId), plan: "Review" };
    const context = {
      ...mockContext,
      currentToolCallId:
        failure === "missing call ID"
          ? undefined
          : failure === "invalid call ID"
            ? "bad\u0000id"
            : failure === "oversized call ID"
              ? "\u03bb".repeat(257)
              : "approved-call",
      suppressContentLogging: failure === "redacted context",
      mrtr: { enabled: true, clientCapabilities: { elicitation: {} } },
    };
    const attempt = executeArchestraTool(
      toolFullName,
      failure === "mismatched execution"
        ? {
            ...args,
            execution: {
              v: 1,
              kind: "appa_remedy",
              call_id: "approved-call",
              tool_name: toolFullName,
              original_arguments: JSON.stringify({
                offer_id: offerId,
                plan: "Another plan",
              }),
            },
          }
        : args,
      context,
    );
    if (
      failure === "full entry budget" ||
      failure === "full byte budget" ||
      failure === "mismatched execution"
    ) {
      await expect(attempt).rejects.toMatchObject({ statusCode: 400 });
    } else {
      const response = await attempt;
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response.content)).not.toContain("Authorized");
      expect(JSON.stringify(response.content)).not.toContain("review_required");
    }
    expect(load).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
    expect(await db.select().from(schema.openappaRewritePairsTable)).toEqual(
      pairsBefore,
    );
    expect(await getHitlReview({ session, offerId })).toEqual(review);
    expect(await consumeHitlRuling({ session, offerId })).toBe("approve");
  });

  test.each([
    "approve",
    "deny",
  ] as const)("retains pending and %s terminal exact bytes in two reserved slots", async (ruling) => {
    config.openappa.rewrite = {
      ...config.openappa.rewrite,
      maxEntries: 2,
    };
    const session = ownedControlSession();
    const offerId = "offer-two-rounds";
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue({
      offer_id: offerId,
      session_id: session.session_id,
      text: "Approve this exact call?",
      tool: "archestra__todo_write",
      arguments: VALID_TODO,
    });
    const terminalBytes =
      ruling === "approve"
        ? "Authorized exactly.\nTell the user which plan was accepted."
        : "The user denied this plan.\nKeep the call blocked.";
    const execute = vi
      .spyOn(openappaService, "executeRemedyByOffer")
      .mockImplementation(async () => {
        const pairs = await db.select().from(schema.openappaRewritePairsTable);
        expect(pairs).toHaveLength(2);
        expect(
          pairs.filter((pair) => pair.reservationExpiresAt !== null),
        ).toHaveLength(1);
        expect(
          await AppaRewriteReplay.readControlReceipts({
            session,
            toolCallIds: ["terminal-call"],
          }),
        ).toEqual(new Map());
        return {
          known: true,
          result: {
            content: [{ type: "text" as const, text: terminalBytes }],
          },
        };
      });
    const args = { ...signedRemedyArgs(orgId, offerId), plan: "Review" };
    const context = {
      ...mockContext,
      mrtr: { enabled: true, clientCapabilities: { elicitation: {} } },
    };
    const pending = await executeArchestraTool(toolFullName, args, {
      ...context,
      currentToolCallId: "pending-call",
    });
    expect(pending.structuredContent).toMatchObject({
      outcome: "review_required",
      offer_id: offerId,
    });
    expect(execute).not.toHaveBeenCalled();
    const pendingBytes = pending.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    expect(await recordHitlRuling({ session, offerId, ruling })).toBe(true);
    const terminal = await executeArchestraTool(toolFullName, args, {
      ...context,
      currentToolCallId: "terminal-call",
    });
    expect(terminal.content).toEqual([{ type: "text", text: terminalBytes }]);
    expect(extractMcpHumanRuling(terminal)).toBe(ruling);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ ruling, toolCallId: "terminal-call" }),
    );
    expect(await consumeHitlRuling({ session, offerId })).toBeUndefined();
    expect(
      await AppaRewriteReplay.readControlReceipts({
        session,
        toolCallIds: ["pending-call", "terminal-call"],
      }),
    ).toEqual(
      new Map([
        ["pending-call", { outcome: "pending", bytes: pendingBytes }],
        [
          "terminal-call",
          {
            outcome: ruling === "approve" ? "applied" : "denied",
            bytes: terminalBytes,
          },
        ],
      ]),
    );
    const pairs = await db.select().from(schema.openappaRewritePairsTable);
    expect(pairs).toHaveLength(2);
    expect(
      pairs.every(
        (pair) =>
          pair.reservedBytes === 0 && pair.reservationExpiresAt === null,
      ),
    ).toBe(true);
    const repeated = await executeArchestraTool(toolFullName, args, {
      ...context,
      currentToolCallId: "terminal-call",
    });
    expect(repeated.isError).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("property-order changes keep the semantic identity but cannot reuse a completed call ID", async () => {
    const load = vi
      .spyOn(openappaService, "loadOfferReview")
      .mockResolvedValue(null);
    const execute = vi
      .spyOn(openappaService, "executeRemedyByOffer")
      .mockResolvedValue({
        known: true,
        result: {
          content: [{ type: "text", text: "Exact authorized bytes." }],
        },
      });
    const reserve = vi.spyOn(AppaRewriteReplay, "reserveControlOutcome");
    const signed = signedRemedyArgs(orgId, "offer-order");
    const first = {
      ...signed,
      plan: "Review",
      return_schema: { outer: { b: 2, a: 1 }, order: [2, 1] },
    };
    const second = {
      return_schema: { order: [2, 1], outer: { a: 1, b: 2 } },
      plan: "Review",
      ...signed,
    };
    const execution = (original: object) => ({
      v: 1,
      kind: "appa_remedy",
      call_id: "ordered-call",
      tool_name: toolFullName,
      original_arguments: JSON.stringify(original),
    });
    const admitted = await executeArchestraTool(
      toolFullName,
      {
        ...first,
        execution: execution({
          offer_id: signed.offer_id,
          plan: first.plan,
          return_schema: first.return_schema,
        }),
      },
      mockContext,
    );
    expect(admitted.isError).not.toBe(true);
    const repeated = await executeArchestraTool(
      toolFullName,
      {
        ...second,
        execution: execution({
          return_schema: second.return_schema,
          plan: second.plan,
          offer_id: signed.offer_id,
        }),
      },
      mockContext,
    );
    expect(repeated.isError).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(reserve.mock.calls[0][0].requestIdentity).toMatch(/^[0-9a-f]{64}$/);
    expect(reserve.mock.calls[1][0].requestIdentity).toBe(
      reserve.mock.calls[0][0].requestIdentity,
    );
    expect(
      await AppaRewriteReplay.readControlReceipts({
        session: ownedControlSession(),
        toolCallIds: ["ordered-call"],
      }),
    ).toEqual(
      new Map([
        [
          "ordered-call",
          { outcome: "applied", bytes: "Exact authorized bytes." },
        ],
      ]),
    );
  });

  test.each([
    "runtime error",
    "oversized result",
  ] as const)("keeps an uncertain reservation without exposing bytes or re-executing after %s", async (failure) => {
    const session = ownedControlSession();
    const offerId = "offer-uncertain";
    await stageHitlReview({
      session,
      review: { offerId, text: "Approve this exact call?" },
    });
    await recordHitlRuling({ session, offerId, ruling: "approve" });
    const load = vi
      .spyOn(openappaService, "loadOfferReview")
      .mockResolvedValue({
        offer_id: offerId,
        session_id: session.session_id,
        text: "Approve this exact call?",
      });
    const execute = vi.spyOn(openappaService, "executeRemedyByOffer");
    if (failure === "runtime error") {
      execute.mockRejectedValue(new Error("Synthetic interrupted remedy"));
    } else {
      execute.mockResolvedValue({
        known: true,
        result: {
          content: [{ type: "text", text: "x".repeat(1024 * 1024) }],
        },
      });
    }
    const args = { ...signedRemedyArgs(orgId, offerId), plan: "Review" };
    const context = {
      ...mockContext,
      currentToolCallId: "uncertain-call",
      mrtr: { enabled: true, clientCapabilities: { elicitation: {} } },
    };
    const attempt = executeArchestraTool(toolFullName, args, context);
    if (failure === "runtime error") {
      await expect(attempt).rejects.toThrow("Synthetic interrupted remedy");
    } else {
      await expect(attempt).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(
      await AppaRewriteReplay.readControlReceipts({
        session,
        toolCallIds: [context.currentToolCallId],
      }),
    ).toEqual(new Map());
    const pairs = await db.select().from(schema.openappaRewritePairsTable);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].reservationExpiresAt).not.toBeNull();
    expect(pairs[0].reservedBytes).toBeGreaterThan(0);
    const repeated = await executeArchestraTool(toolFullName, args, context);
    expect(repeated.isError).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test.each([
    false,
    true,
  ])("chat client: prompts user and passes approve ruling (logo=%s)", async (logo) => {
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue({
      offer_id: "offer-hitl",
      text: logo
        ? '▄█▄▄▄█▄  ▀▀█  Approve this call?\n██▄█▄██   ▄   mcp/example/write {"note":"keep ▀▀█ and ▄"}'
        : "Approve this email?",
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
        ...signedRemedyArgs(orgId, "offer-hitl"),
        plan: "Human review",
      },
      chatContext,
    );

    expect(elicitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
        message: logo
          ? '▄█▄▄▄█▄  Approve this call?\n██▄█▄██  mcp/example/write {"note":"keep ▀▀█ and ▄"}'
          : "Approve this email?",
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
      { ...signedRemedyArgs(orgId, "offer-hitl"), plan: "Human review" },
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

  test("chat client: a precheck refusal names the tool as the model spelled it", async () => {
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
        ...signedRemedyArgs(orgId, "offer-hitl", {
          tool: "archestra__todo_write",
          spelling: "mcp__archestra__todo_write",
        }),
        plan: "Human review",
      },
      { ...mockContext, elicitation: { elicit: vi.fn() } as any },
    );

    const { precheckRefusal } = executeSpy.mock.calls[0][0];
    expect(precheckRefusal).toMatch(
      /^\[appa\] Not submitted for approval: this call to mcp__archestra__todo_write could not/,
    );
    expect(precheckRefusal).toMatch(
      /call mcp__archestra__todo_write again; the corrected call gets its own approval\.$/,
    );
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
      { ...signedRemedyArgs(orgId, "offer-hitl"), plan: "Human review" },
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
    await db
      .update(schema.openappaSessionsTable)
      .set({ callerId: `user:${member.id}` })
      .where(eq(schema.openappaSessionsTable.organizationId, orgId));
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
        ...signedRemedyArgs(orgId, "offer-hitl", {
          callerId: `user:${member.id}`,
        }),
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
      { ...signedRemedyArgs(orgId, "offer-hitl"), plan: "Human review" },
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
        ...signedRemedyArgs(orgId, "offer-hitl"),
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
      { ...signedRemedyArgs(orgId, "offer-hitl"), plan: "Human review" },
      { ...mockContext, elicitation: { elicit: elicitSpy } as any },
    );

    expect(elicitSpy).toHaveBeenCalledTimes(1);
    expect(extractMcpHumanRuling(result)).toBeNull();
  });

  test("chat client: accept without a valid content action fails closed to undefined ruling", async () => {
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue({
      offer_id: "offer-hitl",
      text: "Approve this email?",
      session_id: "session-1",
    });
    const executeSpy = vi
      .spyOn(openappaService, "executeRemedyByOffer")
      .mockResolvedValue({
        result: {
          content: [{ type: "text", text: "email-operator gave no answer" }],
        },
        known: true,
      });

    // Malformed answer: accepted the elicitation but no explicit approve/deny.
    const elicitSpy = vi.fn().mockResolvedValue({
      status: "answered",
      result: { action: "accept" },
    });

    const chatContext: ArchestraContext = {
      ...mockContext,
      elicitation: {
        elicit: elicitSpy,
      } as any,
    };

    await executeArchestraTool(
      toolFullName,
      {
        ...signedRemedyArgs(orgId, "offer-hitl"),
        plan: "Human review",
      },
      chatContext,
    );

    expect(executeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        args: { offer_id: "offer-hitl" },
        ruling: undefined,
      }),
    );
  });

  test("chat client: user cancels passes undefined ruling (yields NoAnswer)", async () => {
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue({
      offer_id: "offer-hitl",
      text: "Approve this email?",
      session_id: "session-1",
    });
    const executeSpy = vi
      .spyOn(openappaService, "executeRemedyByOffer")
      .mockResolvedValue({
        result: {
          content: [{ type: "text", text: "email-operator gave no answer" }],
        },
        known: true,
      });

    const elicitSpy = vi.fn().mockResolvedValue({
      status: "answered",
      result: { action: "cancel" },
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
        ...signedRemedyArgs(orgId, "offer-hitl"),
        plan: "Human review",
      },
      chatContext,
    );

    expect(executeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        args: { offer_id: "offer-hitl" },
        ruling: undefined,
      }),
    );
    expect(extractMcpHumanRuling(result)).toBeNull();
  });

  test("mcp gateway stages the exact review before requesting native input", async () => {
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue({
      offer_id: "offer-hitl",
      text: "Approve this action?",
      session_id: "session-1",
      tool: "archestra__todo_write",
      arguments: VALID_TODO,
    });

    await retainControlSession(orgId);
    const gatewayContext: ArchestraContext = {
      ...mockContext,
      currentToolCallId: "toolu_gateway_review",
      mrtr: {
        enabled: true,
        clientCapabilities: { elicitation: {} },
      },
    };

    const executeSpy = vi.spyOn(openappaService, "executeRemedyByOffer");
    const result = await executeArchestraTool(
      toolFullName,
      {
        ...signedRemedyArgs(orgId, "offer-hitl"),
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
      await getHitlAskUserArguments({
        session: {
          organization_id: orgId,
          caller_id: `user:${mockContext.userId}`,
          session_id: "session-1",
        },
        offerIds: ["offer-hitl"],
      }),
    ).toMatchObject({
      question: "Approve this action?",
      remedy_offer_ids: ["offer-hitl"],
    });
  });

  test("stages native restrictions on the question and does not store an unkeyed encrypted chat", async () => {
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue({
      offer_id: "offer-restricted",
      text: "Approve this call?",
      session_id: "session-1",
      restrictions: [
        { dimension: "trust", before: "trusted", after: "suspicious" },
      ],
    });
    await executeArchestraTool(
      toolFullName,
      {
        ...signedRemedyArgs(orgId, "offer-restricted"),
        plan: "Accept restriction",
      },
      {
        ...mockContext,
        currentToolCallId: "toolu_restricted",
        mrtr: { enabled: true, clientCapabilities: { elicitation: {} } },
      },
    );
    const asked = await getHitlAskUserArguments({
      session: {
        organization_id: orgId,
        caller_id: `user:${mockContext.userId}`,
        session_id: "session-1",
      },
      offerIds: ["offer-restricted"],
    });
    expect(asked?.question).toContain("trusted -> suspicious");
    expect(asked?.question).toContain("authorizes this exact call");
    expect(asked?.question).toContain("label changes");
    expect(asked?.question).toContain("do not add permissions");
    expect(asked?.question).toContain("does not accept the restriction");
    expect(asked?.options.map((option) => option.label)).toEqual([
      "Approve",
      "Deny",
    ]);
    expect(asked?.options[1]?.description).toContain(
      "do not accept the listed restrictions",
    );

    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue({
      offer_id: "offer-sealed",
      text: "Approve this call?",
      session_id: "session-1",
    });
    const storedBefore = await db
      .select({ fragmentKey: schema.openappaRewritePairsTable.fragmentKey })
      .from(schema.openappaRewritePairsTable)
      .where(eq(schema.openappaRewritePairsTable.organizationId, orgId));
    const sealed = await executeArchestraTool(
      toolFullName,
      { ...signedRemedyArgs(orgId, "offer-sealed"), plan: "Sealed" },
      {
        ...mockContext,
        currentToolCallId: "toolu_sealed",
        suppressContentLogging: true,
        mrtr: { enabled: true, clientCapabilities: { elicitation: {} } },
      },
    );
    expect(sealed.isError).toBe(true);
    expect(JSON.stringify(sealed.content)).not.toContain("review_required");
    const storedAfter = await db
      .select({ fragmentKey: schema.openappaRewritePairsTable.fragmentKey })
      .from(schema.openappaRewritePairsTable)
      .where(eq(schema.openappaRewritePairsTable.organizationId, orgId));
    expect(storedAfter).toHaveLength(storedBefore.length);
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
      { ...signedRemedyArgs(orgId, "offer-hitl"), plan: "Review" },
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
      caller_id: `user:${mockContext.userId}`,
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
        ...signedRemedyArgs(orgId, "offer-hitl"),
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
    const repeated = await executeArchestraTool(
      toolFullName,
      {
        ...signedRemedyArgs(orgId, "offer-hitl"),
        plan: "Review",
      },
      gatewayContext,
    );
    expect(repeated.isError).toBe(true);
    expect(executeSpy).not.toHaveBeenCalled();
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

    await retainControlSession(orgId);
    // Codex/OpenCode: no elicitation capability
    const codexContext: ArchestraContext = {
      ...mockContext,
      currentToolCallId: "toolu_codex_review",
      mrtr: {
        enabled: true,
        clientCapabilities: {},
      },
    };

    const result = await executeArchestraTool(
      toolFullName,
      {
        ...signedRemedyArgs(orgId, "offer-hitl"),
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
