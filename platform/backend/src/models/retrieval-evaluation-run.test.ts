import RetrievalEvaluationRunModel from "@/models/retrieval-evaluation-run";
import { describe, expect, test } from "@/test";
import { isUniqueConstraintError } from "@/utils/db";

describe("RetrievalEvaluationRunModel", () => {
  test("enforces one active run per organization and frees the slot at terminal status", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    const first = await createRun({
      organizationId: organization.id,
      userId: user.id,
    });

    let conflict: unknown;
    try {
      await createRun({ organizationId: organization.id, userId: user.id });
    } catch (error) {
      conflict = error;
    }
    expect(isUniqueConstraintError(conflict)).toBe(true);

    await RetrievalEvaluationRunModel.markFailed({
      id: first.id,
      error: "test failure",
    });
    await expect(
      createRun({ organizationId: organization.id, userId: user.id }),
    ).resolves.toMatchObject({ status: "queued" });
  });

  test("serializes execution globally while keeping other organizations queued", async ({
    makeOrganization,
    makeUser,
  }) => {
    const [organizationA, organizationB] = await Promise.all([
      makeOrganization(),
      makeOrganization(),
    ]);
    const user = await makeUser();
    const [runA, runB] = await Promise.all([
      createRun({ organizationId: organizationA.id, userId: user.id }),
      createRun({ organizationId: organizationB.id, userId: user.id }),
    ]);

    expect(
      await RetrievalEvaluationRunModel.claimForExecution(runA.id),
    ).toMatchObject({ status: "claimed" });
    expect(
      await RetrievalEvaluationRunModel.claimForExecution(runB.id),
    ).toEqual({ status: "busy" });

    await RetrievalEvaluationRunModel.markFailed({
      id: runA.id,
      error: "finished for test",
    });
    expect(
      await RetrievalEvaluationRunModel.claimForExecution(runB.id),
    ).toMatchObject({ status: "claimed" });
  });

  test("cancels queued work immediately and running work cooperatively", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    const queued = await createRun({
      organizationId: organization.id,
      userId: user.id,
    });
    const cancelled = await RetrievalEvaluationRunModel.requestCancellation({
      id: queued.id,
      organizationId: organization.id,
    });
    expect(cancelled).toMatchObject({
      status: "cancelled",
      stage: "completed",
    });

    const running = await createRun({
      organizationId: organization.id,
      userId: user.id,
    });
    await RetrievalEvaluationRunModel.claimForExecution(running.id);
    const requested = await RetrievalEvaluationRunModel.requestCancellation({
      id: running.id,
      organizationId: organization.id,
    });
    expect(requested?.status).toBe("cancel_requested");
    expect(
      await RetrievalEvaluationRunModel.isCancellationRequested(running.id),
    ).toBe(true);
  });

  test("retains fixture identity on failure for crash cleanup but omits artifacts from audit snapshots", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    const run = await createRun({
      organizationId: organization.id,
      userId: user.id,
    });
    const knowledgeBaseId = crypto.randomUUID();
    const connectorId = crypto.randomUUID();
    await RetrievalEvaluationRunModel.setFixture({
      id: run.id,
      knowledgeBaseId,
      connectorId,
    });
    await RetrievalEvaluationRunModel.markBm25Refreshed(run.id);
    await RetrievalEvaluationRunModel.markFailed({
      id: run.id,
      error: "worker stopped",
    });

    const stored = await RetrievalEvaluationRunModel.findById(run.id);
    expect(stored).toMatchObject({
      fixtureKnowledgeBaseId: knowledgeBaseId,
      fixtureConnectorId: connectorId,
      bm25Refreshed: true,
    });
    const audit = await RetrievalEvaluationRunModel.findByIdForAudit(
      run.id,
      organization.id,
    );
    expect(audit).not.toHaveProperty("artifact");
    expect(audit).not.toHaveProperty("error");
  });
});

function createRun(params: { organizationId: string; userId: string }) {
  return RetrievalEvaluationRunModel.create({
    organizationId: params.organizationId,
    requestedByUserId: params.userId,
    name: "Evaluation test",
    queryLimit: 10,
  });
}
