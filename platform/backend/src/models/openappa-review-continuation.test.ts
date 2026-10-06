import { A2AProtocolRole } from "@/agents/a2a/a2a-protocol";
import { A2AContextModel, A2ATaskModel } from "@/models";
import { emailReviewOrigin } from "@/openappa/review-origin";
import { expect, test } from "@/test";
import OpenAppaReviewContinuationModel from "./openappa-review-continuation";

test("review submission and phase claims are durable, once-only and token-bound", async ({
  makeUser,
  makeOrganization,
  makeAgent,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({
    organizationId: organization.id,
    agentType: "agent",
  });
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: user.id,
  });
  const task = await A2ATaskModel.createForRun({
    contextId: context.id,
    agentId: agent.id,
  });
  const submission = {
    organizationId: organization.id,
    actorUserId: user.id,
    taskId: task.id,
    approvalId: crypto.randomUUID(),
    approved: true,
    agentId: agent.id,
    sessionId: "original-owned-session",
    origin: emailReviewOrigin({
      messageId: "original",
      fromAddress: "owner@example.com",
      toAddress: "agents@example.com",
      conversationId: "thread",
      receivedAt: new Date(),
      subject: "",
      body: "Not stored",
    }),
  };
  const attempts = await Promise.all([
    OpenAppaReviewContinuationModel.enqueue(submission),
    OpenAppaReviewContinuationModel.enqueue({ ...submission, approved: false }),
  ]);
  expect(attempts[0].id).toBe(attempts[1].id);
  expect(attempts[0].approved).toBe(attempts[1].approved);
  const row = attempts[0];
  const claims = await Promise.all(
    [1, 2].map(() =>
      OpenAppaReviewContinuationModel.transition({
        ...row,
        next: "resuming",
        nextClaimId: crypto.randomUUID(),
      }),
    ),
  );
  expect(claims.filter(Boolean)).toHaveLength(1);
  const claim = claims.find((value) => value !== null);
  if (!claim) throw new Error("Missing review claim");
  await expect(
    OpenAppaReviewContinuationModel.transition({
      ...claim,
      claimId: crypto.randomUUID(),
      next: "ready",
    }),
  ).resolves.toBeNull();
  const result = {
    message: {
      messageId: "result",
      role: A2AProtocolRole.Agent,
      parts: [{ text: "Private result" }],
    },
  };
  const ready = await OpenAppaReviewContinuationModel.transition({
    ...claim,
    next: "ready",
    result,
  });
  expect(ready?.result).toEqual(result);
  const audit = await OpenAppaReviewContinuationModel.auditSubmissions(task.id);
  expect(JSON.stringify(audit)).not.toContain("Private result");
  expect(JSON.stringify(audit)).not.toContain("owner@example.com");
  expect(JSON.stringify(audit)).not.toContain("original-owned-session");
  expect(
    (await OpenAppaReviewContinuationModel.find(task.id, row.approvalId))
      ?.state,
  ).toBe("ready");
  if (!ready) throw new Error("Expected saved result");
  const failed = await OpenAppaReviewContinuationModel.transition({
    ...ready,
    next: "failed",
    failureReason: "permission_revoked",
  });
  expect(failed?.result).toBeNull();
  expect(failed).toMatchObject({
    taskId: task.id,
    approvalId: row.approvalId,
    failureReason: "permission_revoked",
    approved: row.approved,
  });
});
