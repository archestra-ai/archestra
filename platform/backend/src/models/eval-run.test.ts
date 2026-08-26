import { expect, test } from "@/test";
import EvalCaseModel from "./eval-case";
import EvalRunModel from "./eval-run";
import EvalRunResultModel from "./eval-run-result";
import EvalSuiteModel from "./eval-suite";

const SAMPLE_ASSERTIONS = [
  {
    type: "contains" as const,
    values: ["ok"],
    mode: "all" as const,
    caseSensitive: false,
  },
];

async function makeSuiteWithCases(params: {
  organizationId: string;
  caseCount: number;
}) {
  const suite = await EvalSuiteModel.create({
    organizationId: params.organizationId,
    name: `Suite ${crypto.randomUUID().slice(0, 8)}`,
  });
  const cases = [];
  for (let i = 0; i < params.caseCount; i++) {
    cases.push(
      await EvalCaseModel.create({
        organizationId: params.organizationId,
        insert: {
          suiteId: suite.id,
          name: `case ${i + 1}`,
          messages: [`input ${i + 1}`],
          assertions: SAMPLE_ASSERTIONS,
        },
      }),
    );
  }
  return { suite, cases };
}

async function makeRun(params: {
  organizationId: string;
  agentId: string;
  userId: string;
  caseCount?: number;
}) {
  const { suite, cases } = await makeSuiteWithCases({
    organizationId: params.organizationId,
    caseCount: params.caseCount ?? 2,
  });
  const run = await EvalRunModel.createWithResults({
    organizationId: params.organizationId,
    suiteId: suite.id,
    agentId: params.agentId,
    groupId: crypto.randomUUID(),
    agentNameSnapshot: "Test Agent",
    modelSnapshot: "claude-sonnet-5",
    name: null,
    createdBy: params.userId,
    cases,
  });
  return { suite, cases, run };
}

test("createWithResults snapshots cases into pending results", async ({
  makeOrganization,
  makeInternalAgent,
  makeUser,
}) => {
  const org = await makeOrganization();
  const agent = await makeInternalAgent({ organizationId: org.id });
  const user = await makeUser();
  const { cases, run } = await makeRun({
    organizationId: org.id,
    agentId: agent.id,
    userId: user.id,
  });

  expect(run.status).toBe("pending");
  expect(run.totalCases).toBe(2);

  const results = await EvalRunResultModel.listAllByRun(run.id);
  expect(results).toHaveLength(2);
  expect(results.map((r) => r.status)).toEqual(["pending", "pending"]);
  expect(results.map((r) => r.caseId)).toEqual(cases.map((c) => c.id));
  expect(results.map((r) => r.messages)).toEqual([["input 1"], ["input 2"]]);

  // Editing the case afterwards does not change the snapshot.
  await EvalCaseModel.update({
    id: cases[0].id,
    organizationId: org.id,
    updates: { messages: ["edited later"] },
  });
  const after = await EvalRunResultModel.listAllByRun(run.id);
  expect(after[0].messages).toEqual(["input 1"]);
});

test("case deletion nulls caseId on results but keeps the snapshot", async ({
  makeOrganization,
  makeInternalAgent,
  makeUser,
}) => {
  const org = await makeOrganization();
  const agent = await makeInternalAgent({ organizationId: org.id });
  const user = await makeUser();
  const { cases, run } = await makeRun({
    organizationId: org.id,
    agentId: agent.id,
    userId: user.id,
  });

  await EvalCaseModel.delete({ id: cases[0].id, organizationId: org.id });

  const results = await EvalRunResultModel.listAllByRun(run.id);
  expect(results[0].caseId).toBeNull();
  expect(results[0].caseName).toBe("case 1");
  expect(results[1].caseId).toBe(cases[1].id);
});

test("run status transitions are guarded", async ({
  makeOrganization,
  makeInternalAgent,
  makeUser,
}) => {
  const org = await makeOrganization();
  const agent = await makeInternalAgent({ organizationId: org.id });
  const user = await makeUser();
  const { run } = await makeRun({
    organizationId: org.id,
    agentId: agent.id,
    userId: user.id,
  });

  const running = await EvalRunModel.markRunning(run.id);
  expect(running?.status).toBe("running");
  expect(running?.startedAt).not.toBeNull();

  const finalized = await EvalRunModel.finalize({
    id: run.id,
    status: "completed",
    counts: {
      passedCases: 1,
      failedCases: 1,
      erroredCases: 0,
      canceledCases: 0,
    },
  });
  expect(finalized?.status).toBe("completed");
  expect(finalized?.passedCases).toBe(1);

  // Terminal runs cannot be re-claimed, re-finalized, canceled or failed.
  expect(await EvalRunModel.markRunning(run.id)).toBeNull();
  expect(
    await EvalRunModel.finalize({
      id: run.id,
      status: "failed",
      counts: {
        passedCases: 0,
        failedCases: 0,
        erroredCases: 0,
        canceledCases: 0,
      },
    }),
  ).toBeNull();
  expect(await EvalRunModel.cancel(run.id, org.id)).toBeNull();
  expect(await EvalRunModel.markFailed(run.id, "nope")).toBeNull();
});

test("cancel wins over a late finalize and is org-scoped", async ({
  makeOrganization,
  makeInternalAgent,
  makeUser,
}) => {
  const org = await makeOrganization();
  const otherOrg = await makeOrganization();
  const agent = await makeInternalAgent({ organizationId: org.id });
  const user = await makeUser();
  const { run } = await makeRun({
    organizationId: org.id,
    agentId: agent.id,
    userId: user.id,
  });

  await EvalRunModel.markRunning(run.id);
  expect(await EvalRunModel.cancel(run.id, otherOrg.id)).toBeNull();

  const canceled = await EvalRunModel.cancel(run.id, org.id);
  expect(canceled?.status).toBe("canceled");

  // The worker's finalize arrives after the cancel: it must not overwrite.
  expect(
    await EvalRunModel.finalize({
      id: run.id,
      status: "completed",
      counts: {
        passedCases: 2,
        failedCases: 0,
        erroredCases: 0,
        canceledCases: 0,
      },
    }),
  ).toBeNull();
  expect((await EvalRunModel.findById(run.id, org.id))?.status).toBe(
    "canceled",
  );
});

test("result claims are atomic and terminal writes are attempt-owned", async ({
  makeOrganization,
  makeInternalAgent,
  makeUser,
}) => {
  const org = await makeOrganization();
  const agent = await makeInternalAgent({ organizationId: org.id });
  const user = await makeUser();
  const { run } = await makeRun({
    organizationId: org.id,
    agentId: agent.id,
    userId: user.id,
    caseCount: 1,
  });
  const [result] = await EvalRunResultModel.listAllByRun(run.id);

  const claimed = await EvalRunResultModel.claimPending(result.id);
  expect(claimed?.status).toBe("running");
  // A second (overlapping) worker cannot claim the same case.
  expect(await EvalRunResultModel.claimPending(result.id)).toBeNull();

  const completed = await EvalRunResultModel.complete({
    id: result.id,
    status: "passed",
    outputText: "ok",
    toolCalls: ["archestra__whoami"],
    assertionResults: [
      { type: "contains", passed: true, reason: 'output contains "ok"' },
    ],
    sessionId: `eval-${result.id}`,
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    durationMs: 1200,
  });
  expect(completed?.status).toBe("passed");
  expect(completed?.completedAt).not.toBeNull();

  // Terminal rows reject further writes.
  expect(
    await EvalRunResultModel.complete({ id: result.id, status: "error" }),
  ).toBeNull();
});

test("markInterrupted closes a stale running row without re-execution", async ({
  makeOrganization,
  makeInternalAgent,
  makeUser,
}) => {
  const org = await makeOrganization();
  const agent = await makeInternalAgent({ organizationId: org.id });
  const user = await makeUser();
  const { run } = await makeRun({
    organizationId: org.id,
    agentId: agent.id,
    userId: user.id,
    caseCount: 1,
  });
  const [result] = await EvalRunResultModel.listAllByRun(run.id);
  const claimed = await EvalRunResultModel.claimPending(result.id);
  if (!claimed?.startedAt) throw new Error("claim did not set startedAt");

  const interrupted = await EvalRunResultModel.markInterrupted({
    id: result.id,
    observedStartedAt: claimed.startedAt,
  });
  expect(interrupted?.status).toBe("error");
  expect(interrupted?.error).toContain("interrupted");

  // Already-terminal rows are left alone.
  expect(
    await EvalRunResultModel.markInterrupted({
      id: result.id,
      observedStartedAt: claimed.startedAt,
    }),
  ).toBeNull();
});

test("cancelPendingByRun, countByStatus and getSessionIds", async ({
  makeOrganization,
  makeInternalAgent,
  makeUser,
}) => {
  const org = await makeOrganization();
  const agent = await makeInternalAgent({ organizationId: org.id });
  const user = await makeUser();
  const { run } = await makeRun({
    organizationId: org.id,
    agentId: agent.id,
    userId: user.id,
    caseCount: 3,
  });
  const results = await EvalRunResultModel.listAllByRun(run.id);

  await EvalRunResultModel.claimPending(results[0].id);
  await EvalRunResultModel.complete({
    id: results[0].id,
    status: "passed",
    sessionId: "eval-abc",
    judgeSessionId: "eval-judge-abc",
  });

  const canceledCount = await EvalRunResultModel.cancelPendingByRun(run.id);
  expect(canceledCount).toBe(2);

  const counts = await EvalRunResultModel.countByStatus(run.id);
  expect(counts).toEqual({
    pending: 0,
    running: 0,
    passed: 1,
    failed: 0,
    error: 0,
    canceled: 2,
  });

  const sessionIds = await EvalRunResultModel.getSessionIds(run.id);
  expect(sessionIds.sort()).toEqual(["eval-abc", "eval-judge-abc"]);
});

test("list and count filter by suite, agent and status", async ({
  makeOrganization,
  makeInternalAgent,
  makeUser,
}) => {
  const org = await makeOrganization();
  const agentA = await makeInternalAgent({ organizationId: org.id });
  const agentB = await makeInternalAgent({ organizationId: org.id });
  const user = await makeUser();

  const { run: runA, suite: suiteA } = await makeRun({
    organizationId: org.id,
    agentId: agentA.id,
    userId: user.id,
    caseCount: 1,
  });
  const { run: runB } = await makeRun({
    organizationId: org.id,
    agentId: agentB.id,
    userId: user.id,
    caseCount: 1,
  });
  await EvalRunModel.markRunning(runB.id);

  const all = await EvalRunModel.listByOrganization({
    organizationId: org.id,
    limit: 10,
    offset: 0,
  });
  expect(all.map((r) => r.id).sort()).toEqual([runA.id, runB.id].sort());

  const bySuite = await EvalRunModel.listByOrganization({
    organizationId: org.id,
    suiteId: suiteA.id,
    limit: 10,
    offset: 0,
  });
  expect(bySuite.map((r) => r.id)).toEqual([runA.id]);

  const byAgent = await EvalRunModel.listByOrganization({
    organizationId: org.id,
    agentId: agentB.id,
    limit: 10,
    offset: 0,
  });
  expect(byAgent.map((r) => r.id)).toEqual([runB.id]);

  expect(
    await EvalRunModel.countByOrganization({
      organizationId: org.id,
      status: "running",
    }),
  ).toBe(1);

  // Foreign-org lookups see nothing.
  const otherOrg = await makeOrganization();
  expect(await EvalRunModel.findById(runA.id, otherOrg.id)).toBeNull();
  expect(await EvalRunModel.findByIdUnscoped(runA.id)).not.toBeNull();
});
