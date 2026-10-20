import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { userHasPermission } from "@/auth";
import { enterpriseTier } from "@/enterprise-tier";
import { LRUCacheManager } from "@/in-memory-lru-cache";
import logger from "@/logging";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import OpenAppaPolicyTestsModel from "@/models/openappa-policy-tests";
import { memberRosters, openappaBatteriesService } from "@/openappa/batteries";
import { expandCommandExecutionPolicyRules } from "@/openappa/command-normalization";
import { compositionView } from "@/openappa/composition-view";
import { openappaDeclarations } from "@/openappa/declarations";
import { OpenappaCredentialError } from "@/openappa/failure";
import {
  githubPolicyTestVersion,
  policyTestFilesHash,
} from "@/openappa/policy-test-hashes";
import { withOpenappaReplayOwner } from "@/openappa/replay-owner";
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

/** One step of a validation run's progress, as replay works through its files. */
export type PolicyTestProgressEvent =
  | { phase: "file_started"; path: string }
  | {
      phase: "file_finished";
      file: Omit<PolicyTestRunResult["files"][number], "contentHash">;
    };

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
  // The cached copy is current when it was written for this source revision
  // and commit, for the same directory. The sync job moves `sourceCommit`
  // when the repository changes, so until then the cache answers without a
  // GitHub round trip (one listing plus a request per file) and without the
  // policy lock that caching takes. Every Guardrails overview load paid both.
  if (
    local &&
    local.sourceRevision === source.revision &&
    local.sourceCommit === source.sourceCommit &&
    (local.directory ?? "traces") === directory
  ) {
    const files = PolicyTestFilesSchema.parse(local.files);
    return {
      ...fallback,
      files,
      version: githubPolicyTestVersion({
        repo: source.repo,
        commit: source.sourceCommit,
        directory,
        files,
      }),
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
      "The validation files changed or Git sync is enabled; reload before saving",
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
/**
 * The credential values a dispatch would carry for `content`, so replay asks
 * its annotators with the same keys. An unset key leaves the consults that
 * need it unanswered, as a dispatch's would be; a bound key the organization
 * must fix stops the run.
 */
async function replayCredentials(
  organizationId: string,
  content: string,
): Promise<{ values: Record<string, string> } | { error: string }> {
  try {
    const { credentials } = await openappaDeclarations.dispatchPolicy({
      organizationId,
      content,
    });
    return { values: credentials };
  } catch (error) {
    if (error instanceof OpenappaCredentialError)
      return {
        error: `Replay cannot run: ${error.message}; fix the binding in OpenAPPA credentials`,
      };
    throw error;
  }
}
async function evaluateOpenAppaPolicyTests(
  params: {
    organizationId: string;
    userId: string | null;
    files: PolicyTestFile[];
    sourceVersion: string;
    directory: string;
    proposedPolicy?: { content: string; expectedRevision: number };
    /**
     * Told as each file starts and finishes, in order. Every file of the run
     * finishes before this returns, including ones that could not run.
     */
    onProgress?: (event: PolicyTestProgressEvent) => void;
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
  /** Set when the stored composition is run: whether an earlier one stays enforced. */
  let stillEnforced: string | null = null;
  if (params.proposedPolicy) {
    const bound = validation.valid
      ? await openappaDeclarations.resolveWithBindings({
          organizationId: params.organizationId,
          content: policyContent,
        })
      : null;
    const deployed =
      bound &&
      (await openappaBatteriesService.deployedBatteries({
        organizationId: params.organizationId,
        resolution: bound.resolution,
      }));
    const composed =
      bound && deployed
        ? await openappaDeclarations.composeForCheck({
            root: bound.content,
            resolution: bound.resolution,
            deployed,
            memberRosters: memberRosters(
              await openappaBatteriesService.hostMemberRoster({
                organizationId: params.organizationId,
                resolution: bound.resolution,
                deployed,
              }),
            ),
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
    const stored = await openappaBatteriesService.getEffectivePolicy(
      params.organizationId,
    );
    const { served } = compositionView(stored);
    // A refusal that keeps an earlier composition still enforces it, so the
    // run checks what the runtime enforces. Only the root text alone fails.
    effective =
      served.kind === "previous" ? { ...stored, lastError: null } : stored;
    if (served.kind === "previous")
      stillEnforced =
        served.rootRevision === null
          ? `Runs against the earlier composition the runtime still enforces; the latest attempt was refused: ${stored.lastError}`
          : `Runs against the composition of revision ${served.rootRevision} the runtime still enforces; the latest attempt was refused: ${stored.lastError}`;
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
  if (stillEnforced) validation.warnings.push(stillEnforced);
  const native = await import("@archestra/openappa-rs");
  let engineVersion = native.getOpenappaReplayEngineVersion();
  let files: PolicyTestRunResult["files"];
  const progress = params.onProgress
    ? new ReplayProgress(params.onProgress)
    : null;
  // A dispatch evaluates the composition with every command tool's spelling.
  const content = expandCommandExecutionPolicyRules(effective.content);
  const cannotRun = (error: string) =>
    params.files.map((file) => ({
      path: file.path,
      contentHash: hash(file.content),
      assertionCount: 0,
      status: "cannot_run" as const,
      error,
      steps: [],
    }));
  const credentials =
    validation.valid && params.files.length
      ? await replayCredentials(params.organizationId, effective.content)
      : { values: {} };
  const replayInput = (annotatorContext?: string) =>
    JSON.stringify({
      content,
      files: params.files,
      credentials: "values" in credentials ? credentials.values : {},
      annotatorContext,
    });
  const capacityError =
    Buffer.byteLength(content) > 262144
      ? "The effective policy exceeds the replay limit of 256 KiB; configuration validation succeeded but this validation run cannot execute"
      : // A capability adds a fixed-size UUID.
        Buffer.byteLength(replayInput(randomUUID())) > 2097152
        ? "The encoded replay request exceeds the 2 MiB limit"
        : null;
  if (!validation.valid) {
    files = cannotRun("Policy configuration validation failed");
  } else if (capacityError) {
    files = cannotRun(capacityError);
  } else if (!params.files.length) {
    files = [];
  } else if ("error" in credentials) {
    files = cannotRun(credentials.error);
  } else {
    // Replay consults the helper bridge and the archestra annotator as a
    // dispatch does, so it reads the same host variables.
    openappaDeclarations.publishBridgeToken();
    const output = await withOpenappaReplayOwner(
      { organizationId: params.organizationId, userId: params.userId },
      (annotatorContext) =>
        native.replayOpenappaPolicy(
          replayInput(annotatorContext),
          progress?.listener,
        ),
    ).finally(() => progress?.stopListening());
    const response = z
      .object({
        engineVersion: z.string(),
        files: z.array(PolicyTestResultSchema.omit({ contentHash: true })),
      })
      .parse(JSON.parse(output));
    engineVersion = response.engineVersion;
    files = response.files.map((file) => ({
      ...file,
      contentHash: hash(
        params.files.find((input) => input.path === file.path)?.content ?? "",
      ),
    }));
  }
  progress?.settle(files);
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
/**
 * Replays the saved validations against an unsaved policy, without recording
 * a run, so a policy preview shows which checks the change would break. Null
 * when there are no saved validations or they cannot be read or replayed: the
 * policy preview must not fail because of its checks.
 */
export async function replaySavedValidations(params: {
  organizationId: string;
  userId: string;
  proposedPolicy: { content: string; expectedRevision: number };
}) {
  if (!enterpriseTier.isOpenappaActive()) return null;
  try {
    const collection = await loadPolicyTestCollection(
      params.organizationId,
      params.userId,
    );
    if (collection.error || !collection.files.length) return null;
    return await replayOpenAppaDraft(
      {
        ...params,
        files: collection.files,
        sourceVersion: collection.version,
        directory: collection.directory,
      },
      collection,
    );
  } catch (error) {
    logger.warn(
      { err: error, organizationId: params.organizationId },
      "Could not replay saved validations for a policy preview",
    );
    return null;
  }
}

/** Replays draft files without recording a run, reusing an already-loaded suite. */
export async function replayOpenAppaDraft(
  params: Parameters<typeof evaluateOpenAppaPolicyTests>[0],
  collection: PolicyTestCollection,
) {
  const { result } = await evaluateOpenAppaPolicyTests(params, collection);
  return result.files;
}
export async function previewOpenAppaPolicyTest(
  params: Parameters<typeof evaluateOpenAppaPolicyTests>[0] & {
    userId: string;
  },
) {
  const { result } = await evaluateOpenAppaPolicyTests(params);
  return result;
}
export async function runOpenAppaPolicyTests(
  params: Parameters<typeof evaluateOpenAppaPolicyTests>[0] & {
    userId: string;
    /** Run only these saved files instead of the whole suite. */
    partial?: boolean;
  },
) {
  const collection = await loadPolicyTestCollection(
    params.organizationId,
    params.userId,
  );
  assertCurrentCollection(collection, params.sourceVersion);
  const savedFiles = PolicyTestFilesSchema.parse(collection.files);
  if (
    params.partial
      ? !params.files.every((file) =>
          savedFiles.some(
            (item) => item.path === file.path && item.content === file.content,
          ),
        )
      : policyTestFilesHash(params.files) !== policyTestFilesHash(savedFiles)
  )
    throw new ApiError(
      409,
      params.partial
        ? "Run only saved validation files. Save draft changes first or use the editor preview."
        : "Run all requires the complete saved validation suite. Save draft changes first or use the editor preview.",
    );
  const { result, snapshots } = await evaluateOpenAppaPolicyTests(
    params,
    collection,
  );
  if (params.partial) result.partial = true;
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
      error.message === "Too many OpenAPPA replays are running; retry later"
    )
      throw new Error("Policy replay is busy; retry validation");
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
export async function getOpenAppaPolicyTestRuns(organizationId: string) {
  enabled();
  const rows = await OpenAppaPolicyTestsModel.listRuns(organizationId);
  return rows.map((row) => {
    const result = PolicyTestRunResultSchema.parse(row.result);
    return {
      id: row.id,
      createdAt: row.createdAt,
      createdBy: row.createdBy,
      ...result,
    };
  });
}

/**
 * Forwards one replay's native progress to a listener, in order, and makes
 * sure every file of the run is reported finished exactly once. Native events
 * are queued to the event loop and may land after the replay settles, so
 * the run stops listening once replay returns, drops late events, and
 * `settle` reports what is still missing from the final results.
 */
class ReplayProgress {
  private readonly started = new Set<string>();
  private readonly finished = new Set<string>();
  private listening = true;

  constructor(
    private readonly report: (event: PolicyTestProgressEvent) => void,
  ) {}

  /**
   * The native listener. It must never throw: an exception thrown inside a
   * native callback is fatal to the process.
   */
  readonly listener = (json: string) => {
    if (!this.listening) return;
    try {
      const event = NativeReplayProgressSchema.parse(JSON.parse(json));
      if (event.phase === "file_started")
        this.deliver({ phase: "file_started", path: event.path });
      else {
        const { phase: _, ...file } = event;
        this.deliver({ phase: "file_finished", file });
      }
    } catch (error) {
      logger.warn(
        { err: error },
        "Dropped an unreadable replay progress event",
      );
    }
  };

  settle(files: PolicyTestRunResult["files"]) {
    this.stopListening();
    for (const { contentHash: _, ...file } of files) {
      if (this.finished.has(file.path)) continue;
      if (!this.started.has(file.path))
        this.deliver({ phase: "file_started", path: file.path });
      this.deliver({ phase: "file_finished", file });
    }
  }

  stopListening() {
    this.listening = false;
  }

  private deliver(event: PolicyTestProgressEvent) {
    if (event.phase === "file_started") this.started.add(event.path);
    else this.finished.add(event.file.path);
    try {
      this.report(event);
    } catch (error) {
      logger.warn({ err: error }, "Could not report replay progress");
    }
  }
}
const NativeReplayProgressSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("file_started"), path: z.string() }),
  PolicyTestResultSchema.omit({ contentHash: true }).extend({
    phase: z.literal("file_finished"),
  }),
]);

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
