// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
} from "@archestra/shared";
import { vi } from "vitest";
import config from "@/config";
import { signOfferClaims, unsignedOfferClaims } from "@/openappa/offer-claims";
import * as openappaService from "@/openappa/service";
import {
  GATEWAY_INPUT_REQUEST_KEY,
  InputRequiredSignal,
} from "@/routes/mcp-gateway/mrtr";
import * as guardrailsDeployment from "@/services/guardrails-deployment";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

const TEST_SIGNING_SECRET = "test-offer-signing-secret-32chars";

function signedRemedyArgs(organizationId: string, offerId: string) {
  const jws = signOfferClaims(
    unsignedOfferClaims({
      organizationId,
      sessionId: "session-1",
      offerId,
    }),
    TEST_SIGNING_SECRET,
  );
  return { offer_id: offerId, ...jws };
}

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
      }),
    );
    expect(executeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        args: { offer_id: "offer-hitl" },
        ruling: "approve",
      }),
    );
    expect(result.content[0]).toEqual({ type: "text", text: "Authorized" });
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
        result: { content: [{ type: "text", text: "Declined" }] },
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
        ruling: "deny",
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

  test("mcp gateway MRTR: round 1 throws InputRequiredSignal with review text", async () => {
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue({
      offer_id: "offer-hitl",
      text: "Approve this action?",
      session_id: "session-1",
    });

    const gatewayContext: ArchestraContext = {
      ...mockContext,
      mrtr: {
        enabled: true,
        clientCapabilities: { elicitation: {} },
      },
    };

    await expect(
      executeArchestraTool(
        toolFullName,
        {
          ...signedRemedyArgs(orgId, "offer-hitl"),
          plan: "Review",
        },
        gatewayContext,
      ),
    ).rejects.toThrow(InputRequiredSignal);
  });

  test("mcp gateway MRTR: round 2 with accept ruling executes remedy with approve", async () => {
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
        inputResponses: {
          [GATEWAY_INPUT_REQUEST_KEY]: {
            action: "accept",
            content: { action: "approve" },
          },
        },
      },
    };

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
  });

  test("mcp gateway MRTR: client without elicitation capability keeps HITL off", async () => {
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

    await executeArchestraTool(
      toolFullName,
      {
        ...signedRemedyArgs(orgId, "offer-hitl"),
        plan: "Review",
      },
      codexContext,
    );

    expect(executeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        args: { offer_id: "offer-hitl" },
        ruling: undefined,
      }),
    );
  });
});
