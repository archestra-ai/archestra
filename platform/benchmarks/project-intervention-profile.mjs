import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { SEQUENTIAL_TASKS } from "./sequential-project-workload.mjs";

export function projectInterventionProfile(name = "baseline") {
  assert.ok(Object.hasOwn(PROFILES, name), "unknown_intervention_profile");
  if (name === "baseline") return null;
  const selected = PROFILES[name];
  const checkpoints = [
    ...selected.read.map((stage) => checkpoint(stage, "project_read")),
    ...selected.edit.map((stage) => checkpoint(stage, "project_edit")),
    { stage: 15, operation: "project_publish", path: null },
  ].sort(
    (a, b) =>
      a.stage - b.stage ||
      Number(b.operation === "project_read") -
        Number(a.operation === "project_read"),
  );
  const definition = {
    name,
    checkpoints,
    eligibleCoreAndPublishOperations: 57,
    plannedCheckpoints: checkpoints.length,
    plannedOpportunityShare: checkpoints.length / 57,
    authorityMode: "automated-exact-call-signoff",
    productionCalibrated: false,
    workloadScope: "controlled-sequential-project-not-open-ended-production",
  };
  return {
    ...definition,
    definitionHash: createHash("sha256")
      .update(JSON.stringify(definition))
      .digest("hex"),
  };
}

export function interventionRules({ profile, names }) {
  assert.ok(profile?.checkpoints.length > 0);
  return profile.checkpoints.map(({ stage, operation, path }) => {
    const matches = names.filter((name) => name.endsWith(`__${operation}`));
    assert.equal(matches.length, 1, "intervention_tool_missing_or_ambiguous");
    return {
      target: `${matches[0]}${path ? `(path:${path})` : ""}`,
      attention: `benchmark-${profile.name}-${stage}-${operation}`,
    };
  });
}

export function summarizeInterventions({ profile, arm, fixture, helpers }) {
  assert.ok(["off", "on"].includes(arm));
  const completed = profile.checkpoints.filter(({ operation, path }) =>
    fixture.calls.some(
      (call) =>
        call.ok && call.name === operation && (!path || call.path === path),
    ),
  ).length;
  const observed = {
    authorityApprovals: fixture.authorityCalls.filter(
      (call) => call.ruling === "approve",
    ).length,
    getRemedyPlans: helpers.get_remedy_plans ?? 0,
    executeRemedyPlan: helpers.execute_remedy_plan ?? 0,
  };
  const failures = [];
  if (completed !== profile.plannedCheckpoints)
    failures.push("protected_checkpoint_work_incomplete");
  if (
    arm === "on" &&
    Object.values(observed).some((count) => count < profile.plannedCheckpoints)
  )
    failures.push("distributed_interventions_not_observed");
  if (arm === "off" && Object.values(observed).some((count) => count !== 0))
    failures.push("off_arm_unexpected_intervention");
  return {
    profile,
    completedProtectedOperations: completed,
    ...observed,
    qualified: failures.length === 0,
    failures,
    countingScope:
      "Observed successful helper calls and authority approvals, not assumed blocks or added work. Counts may include retries and native return recovery; planned share is not an observed block rate.",
  };
}

export const INTERVENTION_RECOVERY_TASK =
  "Policy review can be required during reads, edits, or publication. When the runtime blocks a call, use its offered remedy workflow and retry only the exact authorized call. Do not skip work, change arguments to evade review, or invent approval. This applies inside the child as well as the parent.";

const PROFILES = {
  baseline: null,
  distributed: { read: [], edit: [2, 5, 9, 13] },
};

function checkpoint(stage, operation) {
  return { stage, operation, path: SEQUENTIAL_TASKS[stage - 1].path };
}
