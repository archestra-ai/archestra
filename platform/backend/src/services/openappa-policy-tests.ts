import { createHash } from "node:crypto";
import { z } from "zod";
import { userHasPermission } from "@/auth";
import { enterpriseTier } from "@/enterprise-tier";
import { LRUCacheManager } from "@/in-memory-lru-cache";
import logger from "@/logging";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import OpenAppaPolicyTestsModel from "@/models/openappa-policy-tests";
import { openappaBatteriesService } from "@/openappa/batteries";
import { openappaDeclarations } from "@/openappa/declarations";
import {
  githubPolicyTestVersion,
  policyTestFilesHash,
} from "@/openappa/policy-test-hashes";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { loadAppaGithubPolicyTests } from "@/services/openappa-github-sync";
import { ApiError } from "@/types";
import {
  type PolicyTestCollection,
  type PolicyTestFile,
  PolicyTestFilesSchema,
  PolicyTestInspectionSchema,
  PolicyTestResultSchema,
  type PolicyTestRunResult,
  PolicyTestRunResultSchema,
} from "@/types/openappa-policy-tests";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function enabled() {
  if (!enterpriseTier.isOpenappaActive())
    throw new ApiError(409, "Enable OpenAPPA before using policy validation");
}
export async function inspectOpenAppaPolicyTests(files: PolicyTestFile[]) {
  enabled();
  const native = await import("@archestra/openappa-rs");
  return PolicyTestInspectionSchema.parse(
    JSON.parse(
      await native.inspectOpenappaPolicyTests(JSON.stringify({ files })),
    ),
  );
}
export async function getOpenAppaPolicyTests(
  organizationId: string,
  userId: string,
): Promise<PolicyTestCollection> {
  return loadPolicyTestCollection(organizationId, userId);
}
async function loadPolicyTestCollection(
  organizationId: string,
  userId: string | null,
): Promise<PolicyTestCollection> {
  enabled();
  const [source, local] = await Promise.all([
    OpenAppaGithubSyncModel.find(organizationId),
    OpenAppaPolicyTestsModel.find(organizationId),
  ]);
  const activeDirectory = source?.interval
    ? (local?.directory ?? "traces")
    : local?.directory || "traces";
  const directory = activeDirectory;
  if (!source?.interval) {
    return {
      source: "local",
      files: local?.files ?? [],
      version: local?.version ?? "empty",
      sourceCommit: null,
      directory: activeDirectory,
      activeDirectory,
      error: null,
    };
  }
  if (
    (source.githubPatId || source.githubAppConfigId) &&
    userId !== null &&
    !(await userHasPermission(userId, organizationId, "credential", "read"))
  )
    throw new ApiError(403, "You do not have access to GitHub credentials");
  const fallback: PolicyTestCollection = {
    source: "github",
    files: [],
    version: `unavailable:${source.revision}`,
    sourceCommit: source.sourceCommit,
    directory,
    activeDirectory,
    error: null,
  };
  if (!activeDirectory) {
    return {
      ...fallback,
      directory: "",
      version: `disabled:${source.revision}`,
    };
  }
  try {
    const files = PolicyTestFilesSchema.parse(
      await loadAppaGithubPolicyTests({ source, directory, allowEmpty: true }),
    );
    const version = githubPolicyTestVersion({
      repo: source.repo,
      commit: source.sourceCommit,
      directory,
      files,
    });
    if (
      !(await OpenAppaPolicyTestsModel.cacheGithub({
        organizationId,
        files,
        directory,
        sourceRevision: source.revision,
        sourceCommit: source.sourceCommit as string,
      }))
    )
      throw new ApiError(
        409,
        "The GitHub policy source changed while loading validation files; reload",
      );
    return { ...fallback, files, version };
  } catch (error) {
    return {
      ...fallback,
      error:
        error instanceof ApiError
          ? error.message
          : "Could not load GitHub policy validation files. Check repository access, the directory and the configured credential.",
    };
  }
}
export async function updateOpenAppaPolicyTests(params: {
  organizationId: string;
  files: PolicyTestFile[];
  expectedVersion: string;
}) {
  enabled();
  const saved = await OpenAppaPolicyTestsModel.saveLocal(params);
  if (!saved)
    throw new ApiError(
      409,
      "The validation files changed or GitHub sync is enabled; reload before saving",
    );
  return {
    source: "local" as const,
    files: saved.files,
    version: saved.version,
    sourceCommit: null,
    directory: saved.directory || "traces",
    activeDirectory: saved.directory || "traces",
    error: null,
  };
}
async function evaluateOpenAppaPolicyTests(
  params: {
    organizationId: string;
    userId: string | null;
    files: PolicyTestFile[];
    sourceVersion: string;
    directory: string;
    proposedPolicy?: { content: string; expectedRevision: number };
  },
  loadedCollection?: PolicyTestCollection,
) {
  enabled();
  const collection =
    loadedCollection ??
    (await loadPolicyTestCollection(params.organizationId, params.userId));
  assertCurrentCollection(collection, params.sourceVersion);
  const root = await guardrailsPolicyService.get(params.organizationId);
  if (
    params.proposedPolicy &&
    params.proposedPolicy.expectedRevision !== root.revision
  )
    throw new ApiError(
      409,
      "The policy changed; read it again before previewing",
    );
  const policyContent = params.proposedPolicy?.content ?? root.content;
  const validation = await guardrailsPolicyService.validate(policyContent, {
    organizationId: params.organizationId,
    previous: root.content,
  });
  let effective: {
    content: string;
    contentHash: string;
    lastError: string | null;
  };
  if (params.proposedPolicy) {
    const bound = validation.valid
      ? await openappaDeclarations.resolveWithBindings({
          organizationId: params.organizationId,
          content: policyContent,
        })
      : null;
    const composed = bound
      ? await openappaDeclarations.composeForCheck({
          root: bound.content,
          resolution: bound.resolution,
        })
      : null;
    const content = composed?.content ?? policyContent;
    effective = {
      content,
      contentHash: hash(content),
      lastError:
        composed && composed.content === null
          ? "Proposal composition failed"
          : null,
    };
  } else {
    effective = await openappaBatteriesService.getEffectivePolicy(
      params.organizationId,
    );
  }
  const currentRoot = await guardrailsPolicyService.get(params.organizationId);
  const currentSource = await OpenAppaGithubSyncModel.find(
    params.organizationId,
  );
  if (
    root.revision !== currentRoot.revision ||
    root.contentHash !== currentRoot.contentHash ||
    (collection.source === "github" &&
      (!currentSource?.interval ||
        currentSource.sourceCommit !== collection.sourceCommit))
  )
    throw new ApiError(
      409,
      "The policy changed while preparing this run; reload and retry",
    );
  if (effective.lastError) {
    validation.valid = false;
    validation.errors.push(
      "The effective policy could not be composed; resolve the OpenAPPA configuration error first",
    );
  }
  const native = await import("@archestra/openappa-rs");
  let engineVersion = native.getOpenappaReplayEngineVersion();
  let files: PolicyTestRunResult["files"];
  const replayInput = JSON.stringify({
    content: effective.content,
    files: params.files,
    noopAnnotator: guardrailsPolicyService.noopAnnotator(),
  });
  const capacityError =
    Buffer.byteLength(effective.content) > 262144
      ? "The effective policy exceeds the offline replay limit of 256 KiB; configuration validation succeeded but this validation run cannot execute"
      : Buffer.byteLength(replayInput) > 2097152
        ? "The encoded replay request exceeds the 2 MiB limit"
        : null;
  if (!validation.valid || capacityError) {
    files = params.files.map((file) => ({
      path: file.path,
      contentHash: hash(file.content),
      assertionCount: 0,
      status: "cannot_run",
      error: !validation.valid
        ? "Policy configuration validation failed"
        : capacityError,
      steps: [],
    }));
  } else if (!params.files.length) {
    files = [];
  } else {
    const response = z
      .object({
        engineVersion: z.string(),
        files: z.array(PolicyTestResultSchema.omit({ contentHash: true })),
      })
      .parse(JSON.parse(await native.replayOpenappaPolicy(replayInput)));
    engineVersion = response.engineVersion;
    files = response.files.map((file) => ({
      ...file,
      contentHash: hash(
        params.files.find((input) => input.path === file.path)?.content ?? "",
      ),
    }));
  }
  const draft =
    Boolean(params.proposedPolicy) ||
    params.files.some(
      (file) =>
        collection.files.find((saved) => saved.path === file.path)?.content !==
        file.content,
    );
  const result: PolicyTestRunResult = {
    source: collection.source,
    sourceVersion: collection.version,
    sourceCommit: collection.sourceCommit,
    definitionHash: policyTestFilesHash(params.files),
    policyRevision: root.revision,
    policyHash: hash(policyContent),
    effectivePolicyHash: effective.contentHash,
    engineVersion,
    draft,
    files,
    validation,
  };
  return {
    result,
    snapshots: {
      files: params.files,
      rootContent: policyContent,
      effectiveContent: effective.content,
      sourceRepo: currentSource?.repo ?? null,
      directory: collection.directory,
    },
  };
}
export async function replayOpenAppaValidationProposal(
  params: Parameters<typeof evaluateOpenAppaPolicyTests>[0] & {
    userId: string;
  },
  collection: PolicyTestCollection,
) {
  const { result } = await evaluateOpenAppaPolicyTests(params, collection);
  return { ...result, draft: true, stale: false };
}
export async function previewOpenAppaPolicyTest(
  params: Parameters<typeof evaluateOpenAppaPolicyTests>[0] & {
    userId: string;
  },
) {
  const { result } = await evaluateOpenAppaPolicyTests(params);
  return {
    ...result,
    stale: isPolicyTestRunStale(
      result,
      await currentPolicyTestRunContext(params.organizationId),
    ),
  };
}
export async function runOpenAppaPolicyTests(
  params: Parameters<typeof evaluateOpenAppaPolicyTests>[0] & {
    userId: string;
  },
) {
  const collection = await loadPolicyTestCollection(
    params.organizationId,
    params.userId,
  );
  assertCurrentCollection(collection, params.sourceVersion);
  if (
    policyTestFilesHash(params.files) !==
    policyTestFilesHash(PolicyTestFilesSchema.parse(collection.files))
  )
    throw new ApiError(
      409,
      "Run all requires the complete saved validation suite. Save draft changes first or use the editor preview.",
    );
  const { result, snapshots } = await evaluateOpenAppaPolicyTests(
    params,
    collection,
  );
  const saved = await OpenAppaPolicyTestsModel.saveRun(
    params.organizationId,
    params.userId,
    result,
    snapshots,
  );
  if (!saved)
    throw new ApiError(
      409,
      "The validation source changed before the run was saved",
    );
  return {
    id: saved.id,
    createdAt: saved.createdAt,
    createdBy: saved.createdBy,
    ...result,
    stale: isPolicyTestRunStale(
      result,
      await currentPolicyTestRunContext(params.organizationId),
    ),
  };
}
export async function runAutomaticOpenAppaPolicyTests(
  payload: Record<string, unknown>,
) {
  return automaticPolicyValidationWorker.run(payload);
}
async function executeAutomaticPolicyValidation(
  payload: Record<string, unknown>,
) {
  const job = z
    .object({
      organizationId: z.string().min(1),
      source: z.enum(["local", "github"]).optional(),
      sourceIdentity: z.string().optional(),
      repo: z.string().nullable().optional(),
      sourceCommit: z.string().optional(),
      directory: z.string().min(1),
      policyHash: z.string(),
      policyRevision: z.number().int().nonnegative().optional(),
      effectivePolicyHash: z.string().optional(),
      engineVersion: z.string().optional(),
      key: z.string(),
    })
    .parse(payload);
  if (!enterpriseTier.isOpenappaActive()) return;
  const [source, suite, root, history] = await Promise.all([
    OpenAppaGithubSyncModel.find(job.organizationId),
    OpenAppaPolicyTestsModel.find(job.organizationId),
    guardrailsPolicyService.get(job.organizationId),
    OpenAppaPolicyTestsModel.listRuns(job.organizationId),
  ]);
  const mode = source?.interval ? "github" : "local";
  const directory = source?.interval
    ? (suite?.directory ?? "traces")
    : suite?.directory || "traces";
  const sourceIdentity =
    OpenAppaPolicyTestsModel.policyValidationSourceIdentity(source, directory);
  if (
    mode !== (job.source ?? "github") ||
    (job.sourceIdentity !== undefined &&
      sourceIdentity !== job.sourceIdentity) ||
    (mode === "github" &&
      (!directory ||
        source?.repo !== job.repo ||
        directory !== job.directory)) ||
    root.contentHash !== job.policyHash ||
    !(await OpenAppaPolicyTestsModel.isPolicyValidationCurrent(
      job.organizationId,
      job.policyHash,
      job.policyRevision,
    )) ||
    history.some(
      (row) =>
        row.result.automaticKey === job.key && !row.result.executionError,
    )
  )
    return;
  await openappaBatteriesService.recompileOrganizations([job.organizationId]);
  const effective = await openappaBatteriesService.getEffectivePolicy(
    job.organizationId,
  );
  const native = await import("@archestra/openappa-rs");
  const engineVersion = native.getOpenappaReplayEngineVersion();
  if (
    (job.effectivePolicyHash !== undefined &&
      effective.contentHash !== job.effectivePolicyHash) ||
    (job.engineVersion !== undefined && engineVersion !== job.engineVersion)
  )
    return;
  const collection = await loadPolicyTestCollection(job.organizationId, null);
  const retryChangedInputs = async () => {
    if (
      await OpenAppaPolicyTestsModel.shouldRetryPolicyValidation({
        ...job,
        source: job.source ?? "github",
        sourceIdentity,
      })
    )
      throw new Error(
        "Policy validation inputs changed; retry with current inputs",
      );
  };
  const recordFailure = async (message: string, files: PolicyTestFile[] = []) =>
    OpenAppaPolicyTestsModel.saveRun(
      job.organizationId,
      null,
      {
        trigger: "policy_change",
        executionError: message,
        source: collection.source,
        sourceVersion:
          collection.source === "github" && collection.error
            ? `unavailable:${source?.repo}:${collection.sourceCommit}:${directory}`
            : collection.version,
        sourceCommit: collection.sourceCommit,
        definitionHash: policyTestFilesHash(files),
        policyRevision: root.revision,
        policyHash: root.contentHash,
        effectivePolicyHash: effective.contentHash,
        engineVersion,
        draft: false,
        validation: { valid: true, errors: [], warnings: [] },
        files: files.map((file) => ({
          path: file.path,
          contentHash: hash(file.content),
          assertionCount: 0,
          status: "cannot_run",
          error: message,
          steps: [],
        })),
      },
      {
        files,
        rootContent: root.content,
        effectiveContent: effective.content,
        sourceRepo: mode === "github" ? (source?.repo ?? null) : null,
        directory,
      },
      job.key,
      sourceIdentity,
    );
  if (collection.error) {
    const saved = await recordFailure(collection.error);
    if (saved) throw new Error(collection.error);
    await retryChangedInputs();
    return;
  }
  if (
    collection.source !== mode ||
    collection.activeDirectory !== directory ||
    !collection.files.length
  )
    return;
  let evaluated: Awaited<ReturnType<typeof evaluateOpenAppaPolicyTests>>;
  try {
    evaluated = await evaluateOpenAppaPolicyTests(
      {
        organizationId: job.organizationId,
        userId: null,
        files: collection.files,
        sourceVersion: collection.version,
        directory,
      },
      collection,
    );
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 409) {
      await retryChangedInputs();
      return;
    }
    if (
      error instanceof Error &&
      error.message === "An OpenAPPA replay is already running; retry later"
    )
      throw new Error("Offline policy replay is busy; retry validation");
    const message = "Could not run informational policy validation";
    const saved = await recordFailure(message, collection.files);
    if (saved) throw new Error(message);
    await retryChangedInputs();
    return;
  }
  if (
    evaluated.result.policyHash !== job.policyHash ||
    !(await OpenAppaPolicyTestsModel.isPolicyValidationCurrent(
      job.organizationId,
      job.policyHash,
      job.policyRevision,
    ))
  )
    return;
  const saved = await OpenAppaPolicyTestsModel.saveRun(
    job.organizationId,
    null,
    { ...evaluated.result, trigger: "policy_change" },
    evaluated.snapshots,
    job.key,
    sourceIdentity,
  );
  if (!saved) {
    await retryChangedInputs();
    return;
  }
  logger.info(
    { organizationId: job.organizationId },
    "Informational policy validation completed",
  );
}
async function currentPolicyTestRunContext(organizationId: string) {
  const [root, effective, source, suite] = await Promise.all([
    guardrailsPolicyService.get(organizationId),
    openappaBatteriesService.getEffectivePolicy(organizationId),
    OpenAppaGithubSyncModel.find(organizationId),
    OpenAppaPolicyTestsModel.find(organizationId),
  ]);
  const native = await import("@archestra/openappa-rs");
  const engineVersion = native.getOpenappaReplayEngineVersion();
  const githubVersion =
    source?.interval && suite?.sourceCommit === source.sourceCommit
      ? githubPolicyTestVersion({
          repo: source.repo,
          commit: source.sourceCommit,
          directory: suite.directory,
          files: suite.files,
        })
      : null;
  return { root, effective, source, suite, engineVersion, githubVersion };
}

function assertCurrentCollection(
  collection: PolicyTestCollection,
  version: string,
) {
  if (collection.error) throw new ApiError(409, collection.error);
  if (collection.source === "github" && !collection.activeDirectory)
    throw new ApiError(
      409,
      "Validation is disabled. Set a validation directory in GitHub source settings before running tests.",
    );
  if (collection.version !== version)
    throw new ApiError(
      409,
      "The validation source changed; reload before running",
    );
}
function isPolicyTestRunStale(
  result: PolicyTestRunResult,
  context: Awaited<ReturnType<typeof currentPolicyTestRunContext>>,
) {
  const { root, effective, source, suite, engineVersion, githubVersion } =
    context;
  return (
    engineVersion !== result.engineVersion ||
    root.contentHash !== result.policyHash ||
    effective.contentHash !== result.effectivePolicyHash ||
    (source?.interval
      ? result.source !== "github" ||
        source.sourceCommit !== result.sourceCommit ||
        (result.executionError &&
        result.sourceVersion.startsWith("unavailable:")
          ? result.sourceVersion !==
            `unavailable:${source.repo}:${source.sourceCommit}:${suite?.directory ?? "traces"}`
          : githubVersion !== result.sourceVersion)
      : result.source !== "local" ||
        (suite?.version ?? "empty") !== result.sourceVersion)
  );
}
export async function getOpenAppaPolicyTestRuns(organizationId: string) {
  enabled();
  const [rows, context] = await Promise.all([
    OpenAppaPolicyTestsModel.listRuns(organizationId),
    currentPolicyTestRunContext(organizationId),
  ]);
  return rows.map((row) => {
    const result = PolicyTestRunResultSchema.parse(row.result);
    return {
      id: row.id,
      createdAt: row.createdAt,
      createdBy: row.createdBy,
      ...result,
      stale: isPolicyTestRunStale(result, context),
    };
  });
}

class AutomaticPolicyValidationWorker {
  private readonly deliveries = new LRUCacheManager<Promise<void>>({
    maxSize: 32,
    defaultTtl: 0,
  });

  run(payload: Record<string, unknown>): Promise<void> {
    const key = JSON.stringify([payload.organizationId, payload.key]);
    const current = this.deliveries.get(key);
    if (current) return current;
    const running = executeAutomaticPolicyValidation(payload).finally(() =>
      this.deliveries.delete(key),
    );
    this.deliveries.set(key, running);
    return running;
  }
}
const automaticPolicyValidationWorker = new AutomaticPolicyValidationWorker();
