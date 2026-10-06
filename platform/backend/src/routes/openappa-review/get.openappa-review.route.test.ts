import crypto from "node:crypto";
import { TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME } from "@archestra/shared";
import type { UIMessage } from "ai";
import { vi } from "vitest";
import type { A2AActor } from "@/agents/a2a/a2a-base";
import {
  A2AContextManager,
  A2ATaskManager,
} from "@/agents/a2a/a2a-model-manager";
import {
  A2AProtocolRole,
  A2AProtocolTaskState,
} from "@/agents/a2a/a2a-protocol";
import config from "@/config";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { stageHitlReview } from "@/openappa/hitl-review";
import { signOfferClaims, unsignedOfferClaims } from "@/openappa/offer-claims";
import * as openappaService from "@/openappa/service";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import type { User } from "@/types";

setupTestCacheManager();

const SECRET = "test-offer-signing-secret-32chars";

describe("GET /api/openappa-reviews/:taskId", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;
  const original = { ...config.openappa };

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    config.openappa = {
      enabled: true,
      yellEnabled: false,
      offerSigningSecret: SECRET,
      postgresMaxConnections: 10,
    };
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    await makeMember(user.id, organizationId);
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });
    const { default: routes } = await import("./openappa-review.routes");
    await app.register(routes);
  });

  afterEach(async () => {
    config.openappa = original;
    vi.restoreAllMocks();
    await app.close();
  });

  test("does not return the ledger to a user who did not sign the offer", async ({
    makeUser,
    makeAgent,
  }) => {
    const owner = await makeUser();
    const agent = await makeAgent({ organizationId });
    const seeded = await seedSignedReview({
      organizationId,
      userId: owner.id,
      agentId: agent.id,
    });
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue({
      offer_id: seeded.offerId,
      text: "secret ledger text",
      session_id: seeded.sessionId,
      tool: "slack_send_message",
      arguments: "{}",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/openappa-reviews/${seeded.taskId}?approvalId=${seeded.approvalId}`,
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain("secret ledger text");
  });
});

async function seedSignedReview(params: {
  organizationId: string;
  userId: string;
  agentId: string;
}) {
  const offerId = "offer-route";
  const sessionId = "session-route";
  const callerId = `user:${params.userId}`;
  const remedyArguments = { offer_id: offerId, plan: "real" };
  const jws = signOfferClaims(
    unsignedOfferClaims({
      organizationId: params.organizationId,
      sessionId,
      offerId,
      callerId,
      tool: "slack_send_message",
    }),
    SECRET,
  );
  const approvalId = crypto.randomUUID();
  const actor: A2AActor = {
    kind: "user",
    id: params.userId,
    organizationId: params.organizationId,
  };
  const context = await A2AContextManager.createContext(actor);
  const uiMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    parts: [
      {
        type: `tool-${TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME}`,
        toolCallId: "call-1",
        state: "approval-requested",
        input: { ...remedyArguments, ...jws },
        approval: { id: approvalId },
      },
    ],
  } as UIMessage;
  const task = await A2ATaskManager.createTask({
    context,
    actor,
    state: A2AProtocolTaskState.InputRequired,
    agentId: params.agentId,
    approvalRequests: [
      {
        approvalId,
        toolCallId: "call-1",
        toolName: TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
        approved: false,
        resolved: false,
      },
    ],
  });
  await A2ATaskManager.addMessageToTask({
    task,
    message: {
      messageId: uiMessage.id,
      contextId: context.id,
      taskId: task.id,
      role: A2AProtocolRole.Agent,
      parts: [{ text: "Review required" }],
    },
    uiMessage,
  });
  await stageHitlReview({
    session: {
      organization_id: params.organizationId,
      session_id: sessionId,
      caller_id: callerId,
    },
    review: {
      offerId,
      text: "secret ledger text",
      tool: "slack_send_message",
      arguments: "{}",
      remedyArguments,
    },
  });
  return { taskId: task.id, approvalId, offerId, sessionId };
}
