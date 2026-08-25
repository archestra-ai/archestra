import { eq } from "drizzle-orm";
import { vi } from "vitest";

vi.mock("@/auth");

const mockExecuteA2AMessage = vi.hoisted(() => vi.fn());
vi.mock("@/agents/a2a-executor", () => ({
  executeA2AMessage: mockExecuteA2AMessage,
}));

const mockRunLlmJudge = vi.hoisted(() => vi.fn());
vi.mock("@/evals/judge", () => ({
  runLlmJudge: mockRunLlmJudge,
}));

import { hasAnyAgentTypeAdminPermission } from "@/auth";
import db, { schema } from "@/database";
import {
  EvalCaseModel,
  EvalRunModel,
  EvalRunResultModel,
  EvalSuiteModel,
} from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import type { EvalAssertion } from "@/types/eval";
import { handleEvalRunExecution } from "./eval-run-handler";

const A2A_RESULT = {
  messageId: "msg-1",
  text: "the answer is 42",
  finishReason: "stop",
  responseUiMessage: {
    id: "asst-1",
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolCallId: "call-1",
        toolName: "archestra__whoami",
        state: "output-available",
      },
      { type: "text", text: "the answer is 42" },
    ],
  },
  usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
};

const CONTAINS_42: EvalAssertion[] = [
  { type: "contains", values: ["42"], mode: "all", caseSensitive: false },
];

async function seedRun(params: {
  organizationId: string;
  agentId: string;
  userId: string;
  cases: Array<{ name: string; input: string; assertions: EvalAssertion[] }>;
}) {
  const suite = await EvalSuiteModel.create({
    organizationId: params.organizationId,
    name: `Suite ${crypto.randomUUID().slice(0, 8)}`,
  });
  const cases = [];
  for (const c of params.cases) {
    cases.push(
      await EvalCaseModel.create({
        organizationId: params.organizationId,
        insert: { suiteId: suite.id, ...c },
      }),
    );
  }
  const run = await EvalRunModel.createWithResults({
    organizationId: params.organizationId,
    suiteId: suite.id,
    agentId: params.agentId,
    agentNameSnapshot: "Test Agent",
    modelSnapshot: null,
    name: null,
    createdBy: params.userId,
    cases,
  });
  return { suite, cases, run };
}

describe("handleEvalRunExecution", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(hasAnyAgentTypeAdminPermission).mockResolvedValue(false);
    mockExecuteA2AMessage.mockReset().mockResolvedValue(A2A_RESULT);
    mockRunLlmJudge.mockReset().mockResolvedValue({
      type: "llm_judge",
      passed: true,
      reason: "meets the criteria",
    });
  });

  test("executes cases in order, grades them and finalizes the run", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const actor = await makeUser();
    await makeMember(actor.id, org.id);
    const agent = await makeInternalAgent({ organizationId: org.id });
    const { run } = await seedRun({
      organizationId: org.id,
      agentId: agent.id,
      userId: actor.id,
      cases: [
        { name: "passing", input: "what is 6x7?", assertions: CONTAINS_42 },
        {
          name: "failing",
          input: "what is 6x7?",
          assertions: [
            {
              type: "contains",
              values: ["not-in-output"],
              mode: "all",
              caseSensitive: false,
            },
          ],
        },
      ],
    });

    await handleEvalRunExecution({ runId: run.id });

    expect(mockExecuteA2AMessage).toHaveBeenCalledTimes(2);
    const results = await EvalRunResultModel.listAllByRun(run.id);
    expect(mockExecuteA2AMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        agentId: agent.id,
        message: "what is 6x7?",
        organizationId: org.id,
        userId: actor.id,
        sessionId: `eval-${results[0].id}`,
        source: "eval:run",
      }),
    );

    expect(results[0].status).toBe("passed");
    expect(results[0].outputText).toBe("the answer is 42");
    expect(results[0].toolCalls).toEqual(["archestra__whoami"]);
    expect(results[0].assertionResults).toHaveLength(1);
    expect(results[0].sessionId).toBe(`eval-${results[0].id}`);
    expect(results[0].judgeSessionId).toBeNull();
    expect(results[0].totalTokens).toBe(120);
    expect(results[0].durationMs).not.toBeNull();
    expect(results[1].status).toBe("failed");

    const finished = await EvalRunModel.findById(run.id, org.id);
    expect(finished?.status).toBe("completed");
    expect(finished?.passedCases).toBe(1);
    expect(finished?.failedCases).toBe(1);
    expect(finished?.completedAt).not.toBeNull();
  });

  test("llm_judge assertions call the judge and record its session", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const actor = await makeUser();
    await makeMember(actor.id, org.id);
    const agent = await makeInternalAgent({ organizationId: org.id });
    const { run } = await seedRun({
      organizationId: org.id,
      agentId: agent.id,
      userId: actor.id,
      cases: [
        {
          name: "judged",
          input: "explain",
          assertions: [{ type: "llm_judge", criteria: "answer is correct" }],
        },
      ],
    });

    await handleEvalRunExecution({ runId: run.id });

    const [result] = await EvalRunResultModel.listAllByRun(run.id);
    expect(mockRunLlmJudge).toHaveBeenCalledWith(
      expect.objectContaining({
        criteria: "answer is correct",
        input: "explain",
        outputText: "the answer is 42",
        organizationId: org.id,
        userId: actor.id,
        sessionId: `eval-judge-${result.id}`,
      }),
    );
    expect(result.status).toBe("passed");
    expect(result.judgeSessionId).toBe(`eval-judge-${result.id}`);
  });

  test("an agent execution error marks the case errored and continues", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const actor = await makeUser();
    await makeMember(actor.id, org.id);
    const agent = await makeInternalAgent({ organizationId: org.id });
    const { run } = await seedRun({
      organizationId: org.id,
      agentId: agent.id,
      userId: actor.id,
      cases: [
        { name: "boom", input: "a", assertions: CONTAINS_42 },
        { name: "ok", input: "b", assertions: CONTAINS_42 },
      ],
    });

    mockExecuteA2AMessage
      .mockRejectedValueOnce(new Error("provider exploded"))
      .mockResolvedValueOnce(A2A_RESULT);

    await handleEvalRunExecution({ runId: run.id });

    const results = await EvalRunResultModel.listAllByRun(run.id);
    expect(results[0].status).toBe("error");
    expect(results[0].error).toBe("provider exploded");
    expect(results[1].status).toBe("passed");

    const finished = await EvalRunModel.findById(run.id, org.id);
    expect(finished?.status).toBe("completed");
    expect(finished?.erroredCases).toBe(1);
    expect(finished?.passedCases).toBe(1);
  });

  test("a judge error marks the case errored, not silently passed", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const actor = await makeUser();
    await makeMember(actor.id, org.id);
    const agent = await makeInternalAgent({ organizationId: org.id });
    const { run } = await seedRun({
      organizationId: org.id,
      agentId: agent.id,
      userId: actor.id,
      cases: [
        {
          name: "judged",
          input: "x",
          assertions: [{ type: "llm_judge", criteria: "anything" }],
        },
      ],
    });
    mockRunLlmJudge.mockRejectedValue(new Error("judge unavailable"));

    await handleEvalRunExecution({ runId: run.id });

    const [result] = await EvalRunResultModel.listAllByRun(run.id);
    expect(result.status).toBe("error");
    expect(result.error).toBe("judge unavailable");
  });

  test("a run canceled before pickup cancels its cases without executing", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const actor = await makeUser();
    await makeMember(actor.id, org.id);
    const agent = await makeInternalAgent({ organizationId: org.id });
    const { run } = await seedRun({
      organizationId: org.id,
      agentId: agent.id,
      userId: actor.id,
      cases: [{ name: "c", input: "x", assertions: CONTAINS_42 }],
    });
    await EvalRunModel.cancel(run.id, org.id);

    await handleEvalRunExecution({ runId: run.id });

    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
    const results = await EvalRunResultModel.listAllByRun(run.id);
    expect(results[0].status).toBe("canceled");
    const finished = await EvalRunModel.findById(run.id, org.id);
    expect(finished?.status).toBe("canceled");
    expect(finished?.canceledCases).toBe(1);
  });

  test("a cancel landing mid-run wins over finalize", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const actor = await makeUser();
    await makeMember(actor.id, org.id);
    const agent = await makeInternalAgent({ organizationId: org.id });
    const { run } = await seedRun({
      organizationId: org.id,
      agentId: agent.id,
      userId: actor.id,
      cases: [{ name: "c", input: "x", assertions: CONTAINS_42 }],
    });

    // The cancel arrives while the (only) case is executing.
    mockExecuteA2AMessage.mockImplementation(async () => {
      await EvalRunModel.cancel(run.id, org.id);
      return A2A_RESULT;
    });

    await handleEvalRunExecution({ runId: run.id });

    const finished = await EvalRunModel.findById(run.id, org.id);
    expect(finished?.status).toBe("canceled");
    // The executed case's result is still recorded.
    const results = await EvalRunResultModel.listAllByRun(run.id);
    expect(results[0].status).toBe("passed");
    expect(finished?.passedCases).toBe(1);
  });

  test("resume skips terminal cases and closes crashed running rows", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const actor = await makeUser();
    await makeMember(actor.id, org.id);
    const agent = await makeInternalAgent({ organizationId: org.id });
    const { run } = await seedRun({
      organizationId: org.id,
      agentId: agent.id,
      userId: actor.id,
      cases: [
        { name: "done", input: "a", assertions: CONTAINS_42 },
        { name: "crashed", input: "b", assertions: CONTAINS_42 },
        { name: "todo", input: "c", assertions: CONTAINS_42 },
      ],
    });
    const results = await EvalRunResultModel.listAllByRun(run.id);
    // First case already completed by the crashed attempt.
    await EvalRunResultModel.claimPending(results[0].id);
    await EvalRunResultModel.complete({ id: results[0].id, status: "passed" });
    // Second case was mid-flight when the previous worker died — long enough
    // ago that it is past the case timeout plus slack (a fresh row would be
    // treated as a live overlapping attempt instead).
    await EvalRunResultModel.claimPending(results[1].id);
    await db
      .update(schema.evalRunResultsTable)
      .set({ startedAt: new Date(Date.now() - 600_000) })
      .where(eq(schema.evalRunResultsTable.id, results[1].id));

    await handleEvalRunExecution({ runId: run.id });

    // Only the third case was executed.
    expect(mockExecuteA2AMessage).toHaveBeenCalledTimes(1);
    const after = await EvalRunResultModel.listAllByRun(run.id);
    expect(after[0].status).toBe("passed");
    expect(after[1].status).toBe("error");
    expect(after[1].error).toContain("interrupted");
    expect(after[2].status).toBe("passed");

    const finished = await EvalRunModel.findById(run.id, org.id);
    expect(finished?.status).toBe("completed");
    expect(finished?.passedCases).toBe(2);
    expect(finished?.erroredCases).toBe(1);
  });

  test("a fresh running row defers finalization instead of clobbering it", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const actor = await makeUser();
    await makeMember(actor.id, org.id);
    const agent = await makeInternalAgent({ organizationId: org.id });
    const { run } = await seedRun({
      organizationId: org.id,
      agentId: agent.id,
      userId: actor.id,
      cases: [
        { name: "in-flight", input: "a", assertions: CONTAINS_42 },
        { name: "todo", input: "b", assertions: CONTAINS_42 },
      ],
    });
    const results = await EvalRunResultModel.listAllByRun(run.id);
    // Case 1 is mid-flight on a live overlapping attempt (fresh startedAt).
    await EvalRunResultModel.claimPending(results[0].id);

    await expect(handleEvalRunExecution({ runId: run.id })).rejects.toThrow(
      "deferring run finalization",
    );

    const after = await EvalRunResultModel.listAllByRun(run.id);
    // The fresh row was neither re-executed nor closed out...
    expect(after[0].status).toBe("running");
    // ...the other case still executed...
    expect(after[1].status).toBe("passed");
    // ...and the run stays running for the retry to finalize.
    expect((await EvalRunModel.findById(run.id, org.id))?.status).toBe(
      "running",
    );
  });

  test("stale validation fails the run cleanly", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const otherOrg = await makeOrganization();
    const actor = await makeUser();
    // The actor is a member of a different org, not the run's org
    // (UserModel.getById needs at least one membership to find the user).
    await makeMember(actor.id, otherOrg.id);
    const agent = await makeInternalAgent({ organizationId: org.id });
    const { run } = await seedRun({
      organizationId: org.id,
      agentId: agent.id,
      userId: actor.id,
      cases: [{ name: "c", input: "x", assertions: CONTAINS_42 }],
    });

    await handleEvalRunExecution({ runId: run.id });

    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
    const finished = await EvalRunModel.findById(run.id, org.id);
    expect(finished?.status).toBe("failed");
    expect(finished?.error).toContain("no longer a member");
    const results = await EvalRunResultModel.listAllByRun(run.id);
    expect(results[0].status).toBe("canceled");
    expect(finished?.canceledCases).toBe(1);
  });

  test("missing payload runId throws; unknown or terminal runs are skipped", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalAgent,
  }) => {
    await expect(handleEvalRunExecution({})).rejects.toThrow("Missing runId");

    // Unknown run: no-op.
    await handleEvalRunExecution({ runId: crypto.randomUUID() });
    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();

    // Terminal run: no-op.
    const org = await makeOrganization();
    const actor = await makeUser();
    await makeMember(actor.id, org.id);
    const agent = await makeInternalAgent({ organizationId: org.id });
    const { run } = await seedRun({
      organizationId: org.id,
      agentId: agent.id,
      userId: actor.id,
      cases: [{ name: "c", input: "x", assertions: CONTAINS_42 }],
    });
    await EvalRunModel.markRunning(run.id);
    await EvalRunModel.finalize({
      id: run.id,
      status: "completed",
      counts: {
        passedCases: 0,
        failedCases: 0,
        erroredCases: 0,
        canceledCases: 0,
      },
    });
    await handleEvalRunExecution({ runId: run.id });
    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
  });
});
