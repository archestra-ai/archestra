import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import config from "@/config";
import { LRUCacheManager } from "@/in-memory-lru-cache";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import { openappaBatteriesService } from "@/openappa/batteries";
import {
  scenarioContent,
  scenarioWitnesses,
} from "@/openappa/scenario-witnesses";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import {
  getOpenAppaPolicyTests,
  inspectOpenAppaPolicyTests,
} from "@/services/openappa-policy-tests";
import { previewOpenAppaValidationChange } from "@/services/openappa-validation-change";
import { ApiError } from "@/types";
import { PolicyTestResultSchema } from "@/types/openappa-policy-tests";
import type { OpenAppaScenarioDiscovery } from "@/types/openappa-scenario-discovery";

type Caller = { organizationId: string; userId: string };
type Snapshot = Awaited<ReturnType<typeof snapshot>>;
const discoveries = new LRUCacheManager<{
  identity: string;
  candidates: OpenAppaScenarioDiscovery["candidates"];
}>({
  maxSize: 128,
  defaultTtl: 10 * 60 * 1000,
  maxBytes: 2 * 1024 * 1024,
  sizeOf: (value) => Buffer.byteLength(JSON.stringify(value)),
});
const scope =
  "Each choice is one exact call in a fresh offline session with the policy's starting labels and empty results. No tools, models, remote helpers, or subagent events execute. Discovery is limited; it does not prove rule coverage, causal restrictions, live behavior, or which outcomes you want.";

async function snapshot(caller: Caller) {
  if (!config.openappa.enabled)
    throw new ApiError(409, "Enable OpenAPPA before discovering validations");
  const [root, source, effective, suite] = await Promise.all([
    guardrailsPolicyService.get(caller.organizationId),
    OpenAppaGithubSyncModel.find(caller.organizationId),
    openappaBatteriesService.getEffectivePolicy(caller.organizationId),
    getOpenAppaPolicyTests(caller.organizationId, caller.userId),
  ]);
  return { root, source, effective, suite };
}
function identity(value: Snapshot) {
  return JSON.stringify([
    value.root.revision,
    value.effective.contentHash,
    value.effective.lastError,
    value.source?.revision,
    value.suite.source,
    value.suite.version,
    value.suite.activeDirectory,
    value.suite.error,
  ]);
}
function cacheKey(caller: Caller, id: string) {
  return `${caller.organizationId}:${caller.userId}:${id}`;
}
async function replay(
  content: string,
  files: { path: string; content: string }[],
) {
  try {
    const native = await import("@archestra/openappa-rs");
    return z
      .object({
        files: z.array(PolicyTestResultSchema.omit({ contentHash: true })),
      })
      .parse(
        JSON.parse(
          await native.replayOpenappaPolicy(
            JSON.stringify({
              content,
              files,
              noopAnnotator: guardrailsPolicyService.noopAnnotator(),
            }),
          ),
        ),
      );
  } catch (error) {
    return {
      files: [],
      error:
        error instanceof Error
          ? error.message
          : "Offline replay is unavailable.",
    };
  }
}

/** A finite generator plus two bounded native batches, never an LLM search loop. */
export async function discoverOpenAppaScenarios(
  caller: Caller,
): Promise<OpenAppaScenarioDiscovery> {
  const current = await snapshot(caller);
  const result: OpenAppaScenarioDiscovery = {
    discoveryId: randomUUID(),
    status: "ready",
    message:
      "Choose an observed behavior you want to preserve. Nothing has been saved.",
    scope,
    evaluated: 0,
    limited: false,
    candidates: [],
    unavailable: [],
  };
  if (current.root.revision === 0 && !current.source?.interval)
    return {
      ...result,
      status: "setup_required",
      scope: "No scenarios were evaluated.",
      message:
        "No policy has been saved. Set up a policy before choosing current-policy validations.",
    };
  const error =
    current.effective.lastError ||
    current.suite.error ||
    (current.suite.source === "github" && !current.suite.activeDirectory
      ? "Set a validation directory in GitHub source settings first."
      : null);
  if (error) return { ...result, status: "unavailable", message: error };
  if (Buffer.byteLength(current.effective.content) > 256 * 1024)
    return {
      ...result,
      status: "unavailable",
      message: "The composed policy exceeds offline replay's 256 KiB limit.",
    };
  const generated = scenarioWitnesses(current.effective.content);
  result.limited = generated.limited;
  result.unavailable = generated.skipped
    .slice(0, 16)
    .map(({ rule, reason }) => ({ tool: rule, kind: "needs_input", reason }));
  if (!generated.calls.length)
    return {
      ...result,
      message:
        "Discovery could not construct a concrete example within its supported syntax. Supply a specific call and arguments, or choose a different behavior.",
    };
  const observed = await replay(
    current.effective.content,
    generated.calls.map((call, index) => ({
      path: `example-${index}.appa`,
      content: scenarioContent(call, "allow"),
    })),
  );
  if ("error" in observed)
    return {
      ...result,
      status: "unavailable",
      message: observed.error ?? "Offline replay is unavailable.",
    };
  result.evaluated = generated.calls.length;
  const existing = await inspectOpenAppaPolicyTests(current.suite.files);
  const candidateTools = new Set<string>();
  for (const [index, call] of generated.calls.entries()) {
    const file = observed.files.find(
      (file) => file.path === `example-${index}.appa`,
    );
    const step = file?.steps[0];
    if (!step || step.status === "cannot_run") {
      if (result.unavailable.length < 32)
        result.unavailable.push({
          tool: call.tool,
          kind: "cannot_run",
          reason:
            "Offline replay could not establish a decision for this call. Tools, models and remote helpers do not execute during replay; this is not a live health check. Use a scenario whose dependencies can be evaluated offline.",
        });
      continue;
    }
    if (step.actual !== "allow" && step.actual !== "deny") {
      result.unavailable.push({
        tool: call.tool,
        kind: "needs_input",
        reason: `Replay returned ${step.actual ?? "no outcome"}. Automatic discovery only offers allow/deny checks; supply a concrete scenario for other outcomes.`,
      });
      continue;
    }
    if (result.candidates.length >= 3 || candidateTools.has(call.tool))
      continue;
    const content = scenarioContent(call, step.actual);
    const id = createHash("sha256").update(content).digest("hex").slice(0, 20);
    result.candidates.push({
      id,
      tool: call.tool,
      arguments: call.arguments,
      decision: step.actual,
      content,
      existingFiles: existing.files
        .filter((file) => file.tools.includes(call.tool))
        .map((file) => file.path),
    });
    candidateTools.add(call.tool);
  }
  // Materialize and verify the exact expected decision the operator can adopt.
  // Do not turn an unavailable step into a denial or repair its prerequisites.
  if (result.candidates.length) {
    const verified = await replay(
      current.effective.content,
      result.candidates.map((candidate) => ({
        path: `${candidate.id}.appa`,
        content: candidate.content,
      })),
    );
    if ("error" in verified)
      return {
        ...result,
        candidates: [],
        status: "unavailable",
        message: verified.error ?? "Offline verification is unavailable.",
      };
    result.candidates = result.candidates.filter((candidate) =>
      verified.files.some(
        (file) =>
          file.path === `${candidate.id}.appa` &&
          file.status === "passed" &&
          file.steps.length === 1,
      ),
    );
  }
  if (identity(await snapshot(caller)) !== identity(current))
    throw new ApiError(
      409,
      "Policy or validations changed during discovery. Refresh the choices.",
    );
  if (!result.candidates.length && !result.limited)
    result.message =
      "No verified allow/deny choices were found within discovery's limits. Review the reasons below or supply a concrete scenario for preview.";
  discoveries.set(cacheKey(caller, result.discoveryId), {
    identity: identity(current),
    candidates: result.candidates,
  });
  return result;
}

/** Selection is explicit intent to preserve this outcome, not permission to save. */
export async function draftOpenAppaScenario(
  caller: Caller,
  input: { discoveryId: string; candidateId: string },
) {
  const stored = discoveries.get(cacheKey(caller, input.discoveryId));
  if (!stored)
    throw new ApiError(410, "These choices expired. Discover scenarios again.");
  const candidate = stored.candidates.find(
    (candidate) => candidate.id === input.candidateId,
  );
  if (!candidate)
    throw new ApiError(404, "Choose a scenario returned by this discovery.");
  const current = await snapshot(caller);
  if (identity(current) !== stored.identity)
    throw new ApiError(
      409,
      "Policy or validations changed. Discover scenarios again before drafting.",
    );
  if (current.suite.files.length >= 32)
    throw new ApiError(
      409,
      "The suite is full. Review an existing validation before adding one.",
    );
  const file = {
    path: `${current.suite.activeDirectory}/${candidate.tool.split("/").at(-1)}-${candidate.decision}-${candidate.id.slice(0, 6)}.appa`,
    content: candidate.content,
  };
  if (current.suite.files.some((existing) => existing.path === file.path))
    throw new ApiError(
      409,
      "This scenario is already saved. Review the existing validation.",
    );
  const preview = await previewOpenAppaValidationChange({
    ...caller,
    expectedRevision: current.root.revision,
    expectedVersion: current.suite.version,
    changes: { upsert: [file], delete: [] },
  });
  if (identity(await snapshot(caller)) !== stored.identity)
    throw new ApiError(
      409,
      "Policy or validations changed during preview. Refresh the choices.",
    );
  return {
    file,
    expectedRevision: current.root.revision,
    expectedVersion: current.suite.version,
    tests: preview.tests,
  };
}
