import { createHash } from "node:crypto";
import {
  SEQUENTIAL_APPLICATION_BYTES,
  SEQUENTIAL_DEFINITION_HASH,
  SEQUENTIAL_TASKS,
  SEQUENTIAL_TICKET,
} from "./sequential-project-workload.mjs";

export const LONG_WORKER_TASK = `${SEQUENTIAL_TICKET}Read ticket.txt first. Complete every stage using only the advertised MCP project tools. The source read supplies the baseline revision, the baseline supplies the edit revision, and the edit supplies the verification revision. Always await each result before issuing the dependent call; do not guess receipts or batch those steps. Use the supplied task contract and cases; read protected checks only if diagnosis is needed. Never edit tests, publish, spawn another agent, or use host files/shell/web. Return the actual final check result and its final revision receipt, so the parent can independently verify and publish. Do not stop after a subset of stages.`;
export const LONG_MAIN_TASK = `${LONG_WORKER_TASK.replace("Never edit tests, publish, spawn another agent, or use host files/shell/web.", "Never edit tests, delegate, or use host files/shell/web.").replace("Return the actual final check result and its final revision receipt, so the parent can independently verify and publish.", "After all stages, use the final revision for one full review check, then publish using that check's returned revision. If publication is blocked, follow the genuine offered get_remedy_plans/execute_remedy_plan workflow and retry exactly the authorized call.")}`;
export const LONG_PARENT_TASK = `Delegate exactly once to a genuine native child and do not perform its edits yourself. Give it this exact task and the benchmark namespace:\n${LONG_WORKER_TASK}\nWait for the actual final child result, using 300000ms wait timeouts where the native tool supports timeout_ms. Do not change models or permissions. After the real child return, independently call project_check with the returned final revision; then call project_publish with the review check's new revision and a verified summary. Await each result; never batch check and publish. Use only actual native collaboration, ToolSearch when tools are deferred, and the configured project MCP tools. Finish only after actual publication.`;

export function isSubstantiveProjectCall({ name, args }) {
  if (typeof name !== "string") return false;
  const operation = name.split("__").at(-1);
  return (
    operation === "project_check" ||
    operation === "project_edit" ||
    (operation === "project_read" &&
      typeof args?.path === "string" &&
      args.path.startsWith("src/"))
  );
}

export function claudeCoreModelResponses({ events, requireChild }) {
  const responses = new Set();
  for (const event of events) {
    if (
      event.type !== "assistant" ||
      !event.message?.id ||
      !!event.parent_tool_use_id !== requireChild
    )
      continue;
    if (
      (event.message.content ?? []).some(
        (block) =>
          block.type === "tool_use" &&
          isSubstantiveProjectCall({ name: block.name, args: block.input }),
      )
    )
      responses.add(event.message.id);
  }
  return responses.size;
}

export function qualifyLongWork({
  fixture,
  coreModelResponses,
  providerEvidence,
  completed,
}) {
  const failures = [];
  const check = (valid, reason) => {
    if (!valid) failures.push(reason);
  };
  const work = fixture.workload;
  const core = fixture.calls.filter((entry) => entry.ok && entry.substantive);
  const operations = Object.fromEntries(
    ["project_read", "project_edit", "project_check"].map((name) => [
      name,
      core.filter((entry) => entry.name === name).length,
    ]),
  );
  check(completed === true, "native_workflow_incomplete");
  check(
    work?.definitionHash === SEQUENTIAL_DEFINITION_HASH,
    "workload_definition_mismatch",
  );
  check(
    work?.applicationInputBytes === SEQUENTIAL_APPLICATION_BYTES,
    "application_context_mismatch",
  );
  check(
    work?.completedStages === SEQUENTIAL_TASKS.length &&
      work?.phase === "published" &&
      fixture.published &&
      fixture.lastCheck?.passed,
    "all_stages_and_review_required",
  );
  check(
    Number.isInteger(coreModelResponses) && coreModelResponses >= 50,
    "fewer_than_50_substantive_model_calls",
  );
  check(core.length >= 50, "fewer_than_50_substantive_tool_calls");
  check(
    core.length === 56 &&
      operations.project_read === 14 &&
      operations.project_edit === 14 &&
      operations.project_check === 28,
    "core_operation_graph_mismatch",
  );
  check(
    fixture.calls.every(
      (entry) => entry.ok || entry.errorKind === "request_validation",
    ),
    "unresolved_project_harness_error",
  );
  check(
    providerEvidence.complete === true,
    "independent_provider_evidence_incomplete",
  );
  return {
    qualified: failures.length === 0,
    failures,
    minimumSubstantiveModelCalls: 50,
    minimumSubstantiveToolCalls: 50,
    coreModelResponses,
    substantiveToolCalls: core.length,
    recoveredToolErrors: fixture.calls.filter(
      (entry) => !entry.ok && entry.errorKind === "request_validation",
    ).length,
    harnessToolErrors: fixture.calls.filter(
      (entry) => !entry.ok && entry.errorKind !== "request_validation",
    ).length,
    coreOperations: operations,
    completedStages: work?.completedStages ?? 0,
    definitionHash: work?.definitionHash ?? null,
    applicationInputBytes: work?.applicationInputBytes ?? null,
    toolArgumentBytes: fixture.calls.reduce(
      (sum, entry) => sum + (entry.argumentBytes ?? 0),
      0,
    ),
    toolResultBytes: fixture.calls.reduce(
      (sum, entry) => sum + (entry.resultBytes ?? 0),
      0,
    ),
    coreGraphHash: createHash("sha256")
      .update(
        JSON.stringify(
          core.map(({ stage, phase, name }) => ({ stage, phase, name })),
        ),
      )
      .digest("hex"),
  };
}
