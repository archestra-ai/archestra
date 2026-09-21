// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  extractMcpHumanRuling,
  MCP_HUMAN_RULING_META_KEY,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
  TOOL_GET_REMEDY_PLANS_SHORT_NAME,
} from "@archestra/shared";
import { vi } from "vitest";
import config from "@/config";
import {
  getHitlAskUserArguments,
  recordHitlRuling,
  stageHitlReview,
} from "@/openappa/hitl-review";
import { signOfferClaims, unsignedOfferClaims } from "@/openappa/offer-claims";
import * as openappaService from "@/openappa/service";
import * as guardrailsDeployment from "@/services/guardrails-deployment";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import {
  type ArchestraContext,
  executeArchestraTool,
  getAllArchestraMcpTools,
} from ".";

vi.mock("@/cache-manager");

const TEST_SIGNING_SECRET = "test-offer-signing-secret-32chars";

function signedRemedyArgs(
  organizationId: string,
  offerId: string,
  names: { tool?: string; spelling?: string } = {},
) {
  const jws = signOfferClaims(
    unsignedOfferClaims({
      organizationId,
      sessionId: "session-1",
      offerId,
      ...names,
    }),
    TEST_SIGNING_SECRET,
  );
  return { offer_id: offerId, ...jws };
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
    "immediately call execute_remedy_plan",
  );
  expect(getPlans?.description).toContain(
    "Do not ask the user for permission first",
  );
  expect(getPlans?.description).not.toContain("use ask_user");
  expect(executePlan?.description).toContain("result says review_required");
  expect(executePlan?.description).toContain(
    "immediately call the declared ask_user tool",
  );
  expect(executePlan?.description).not.toContain(
    "review it before approving the call",
  );
});

describe("openappa remedy plan HITL execution", () => {
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
        ...signedRemedyArgs(orgId, "offer-hitl"),
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
      { ...signedRemedyArgs(orgId, "offer-hitl"), plan: "Human review" },
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

    const gatewayContext: ArchestraContext = {
      ...mockContext,
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
    await executeArchestraTool(
      toolFullName,
      {
        ...signedRemedyArgs(orgId, "offer-hitl"),
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
