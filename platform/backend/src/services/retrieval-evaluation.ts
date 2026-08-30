import { createHash } from "node:crypto";
import fs from "node:fs";
import { LRUCacheManager } from "@/cache-manager";
import config from "@/config";
import { parsePdfBuffer } from "@/knowledge-base/connectors/pdf-utils";
import {
  active,
  applyEvaluationSettingsOverrides,
  inactiveCapabilityReasons,
  inspectEvaluationContext,
  setCapability,
  unavailable,
} from "@/knowledge-base/evaluation/capabilities";
import { compareRuns } from "@/knowledge-base/evaluation/compare";
import { KNOWLEDGE_EVALUATION_COMPONENT_DEFINITIONS } from "@/knowledge-base/evaluation/components";
import {
  assertGoldenMatchesCorpus,
  DEFAULT_CORPUS_PATH,
  DEFAULT_GOLDEN_PATH,
  digestFile,
  loadCorpus,
  loadGolden,
  resolveAssetPath,
} from "@/knowledge-base/evaluation/fixtures";
import { ocrOutputContainsExpected } from "@/knowledge-base/evaluation/ocr-validation";
import {
  RetrievalEvaluationCancelledError,
  runInstance,
} from "@/knowledge-base/evaluation/run";
import {
  type CapabilityState,
  EVALUATION_POLICY_VERSION,
  type EvalCapability,
  KNOWLEDGE_EVALUATION_COMPONENTS,
  type KnowledgeEvaluationComponent,
  RunArtifactSchema,
} from "@/knowledge-base/evaluation/schema";
import { cleanupEvalFixtureByIds } from "@/knowledge-base/evaluation/seed";
import type { OcrConfig } from "@/knowledge-base/kb-llm-client";
import { extractPdfText } from "@/knowledge-base/pdf-ocr";
import logger from "@/logging";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import OrganizationModel from "@/models/organization";
import RetrievalEvaluationRunModel from "@/models/retrieval-evaluation-run";
import TeamModel from "@/models/team";
import { taskQueueService } from "@/task-queue";
import type {
  RetrievalEvaluationRun,
  RetrievalEvaluationRunSummary,
  RetrievalEvaluationSettingsOverrides,
} from "@/types";
import { isUniqueConstraintError } from "@/utils/db";

export class RetrievalEvaluationAlreadyRunningError extends Error {
  constructor(readonly run: RetrievalEvaluationRun) {
    super("A retrieval evaluation is already active for this organization");
    this.name = "RetrievalEvaluationAlreadyRunningError";
  }
}

export class RetrievalEvaluationInvalidSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetrievalEvaluationInvalidSettingsError";
  }
}

class RetrievalEvaluationService {
  async getCapabilities(params: {
    organizationId: string;
    userId?: string;
    settingsOverrides?: RetrievalEvaluationSettingsOverrides;
    validateOnlineFixtures?: boolean;
  }) {
    const settingsOverrides = params.settingsOverrides ?? {};
    if (params.userId && Object.keys(settingsOverrides).length > 0) {
      await assertSettingsKeysAvailable({
        organizationId: params.organizationId,
        userId: params.userId,
        settingsOverrides,
      });
    }
    const [inspectedContext, organization, snapshots] = await Promise.all([
      inspectEvaluationContext(params.organizationId, settingsOverrides),
      OrganizationModel.getById(params.organizationId),
      RetrievalEvaluationRunModel.listComponentSnapshots({
        organizationId: params.organizationId,
        limit: 100,
      }),
    ]);
    const context = applyEvaluationSettingsOverrides({
      context: inspectedContext,
      overrides: settingsOverrides,
    });
    if (!organization)
      throw new Error(`organization not found: ${params.organizationId}`);
    const ocrFixtureIssue = await this.getOcrFixtureIssue();
    if (ocrFixtureIssue) {
      setCapability(context, "ocr", unavailable(ocrFixtureIssue));
    } else if (params.validateOnlineFixtures && context.ocr) {
      const modelIssue = await this.getOcrModelFixtureIssue({
        context,
        organization,
        settingsOverrides,
      });
      if (modelIssue) setCapability(context, "ocr", unavailable(modelIssue));
    }
    if (context.capabilities["hybrid-search"].status === "active") {
      setCapability(
        context,
        "bm25",
        active("the runner refreshes and verifies real BM25 statistics"),
      );
    }
    const { golden, corpusDigest, goldenDigest } = loadSuite();
    const componentFingerprints = buildComponentFingerprints({
      context,
      organization,
      suiteDigest: evaluationSuiteDigest({ corpusDigest, goldenDigest }),
      settingsOverrides,
    });
    const components = KNOWLEDGE_EVALUATION_COMPONENT_DEFINITIONS.map(
      (definition) => {
        const reasons = inactiveCapabilityReasons(
          definition.requires,
          context.capabilities,
        );
        const unavailable = reasons.some((reason) =>
          reason.includes(": unavailable"),
        );
        const latest = snapshots.find((snapshot) =>
          snapshot.selectedComponents.includes(definition.id),
        );
        const currentFingerprint = componentFingerprints[definition.id];
        const changedSinceLastEvaluation =
          !latest ||
          latest.componentFingerprints[definition.id] !== currentFingerprint;
        return {
          id: definition.id,
          label: definition.label,
          description: definition.description,
          mode: definition.mode,
          status:
            reasons.length === 0
              ? ("active" as const)
              : unavailable
                ? ("unavailable" as const)
                : ("disabled" as const),
          detail:
            reasons.length > 0
              ? missingRequirementGuidance({
                  requires: definition.requires,
                  capabilities: context.capabilities,
                })
              : "Ready to evaluate",
          currentFingerprint,
          selectedByDefault: changedSinceLastEvaluation && reasons.length === 0,
          changedSinceLastEvaluation,
          lastEvaluatedAt: latest?.completedAt?.toISOString() ?? null,
          lastRunId: latest?.id ?? null,
          scenarioIds: golden
            .filter((query) => query.component === definition.id)
            .map((query) => query.id),
        };
      },
    );
    const scenarios = golden.map((query) => {
      const reasons = inactiveCapabilityReasons(
        query.requires,
        context.capabilities,
      );
      return {
        id: query.id,
        query: query.query,
        expected: query.expected.map((expected) => expected.doc),
        component: query.component,
        tags: query.tags,
        category: query.category ?? "general",
        language: query.language ?? "en",
        difficulty: query.difficulty ?? "medium",
        answerability: query.answerability ?? "answerable",
        gateMode: query.gateMode ?? "pass-fail",
        forbidden: query.forbidden ?? [],
        judgments: query.judgments ?? [],
        requires: query.requires,
        expectAtK: query.expectAtK,
        applicable: reasons.length === 0,
        reasons,
      };
    });
    return {
      corpusDigest,
      goldenDigest,
      totalQueries: golden.length,
      applicableQueries: scenarios.filter((scenario) => scenario.applicable)
        .length,
      capabilities: context.capabilities,
      components,
      scenarios,
    };
  }

  async startRun(params: {
    organizationId: string;
    userId: string;
    name?: string;
    queryLimit: number;
    components?: KnowledgeEvaluationComponent[];
    settingsOverrides?: RetrievalEvaluationSettingsOverrides;
  }): Promise<RetrievalEvaluationRun> {
    const activeRun =
      await RetrievalEvaluationRunModel.findActiveByOrganization(
        params.organizationId,
      );
    if (activeRun) throw new RetrievalEvaluationAlreadyRunningError(activeRun);

    const settingsOverrides = params.settingsOverrides ?? {};
    await assertSettingsKeysAvailable({
      organizationId: params.organizationId,
      userId: params.userId,
      settingsOverrides,
    });
    const [savedContext, organization] = await Promise.all([
      inspectEvaluationContext(params.organizationId, settingsOverrides),
      OrganizationModel.getById(params.organizationId),
    ]);
    if (!organization) {
      throw new Error(`organization not found: ${params.organizationId}`);
    }
    const context = applyEvaluationSettingsOverrides({
      context: savedContext,
      overrides: settingsOverrides,
    });
    assertRequestedSettingsAvailable({ context, settingsOverrides });
    const selectedComponents = [
      ...new Set(params.components ?? [...KNOWLEDGE_EVALUATION_COMPONENTS]),
    ];
    if (selectedComponents.length === 0) {
      throw new Error("At least one Knowledge component must be selected");
    }
    if (selectedComponents.includes("ocr")) {
      const ocrFixtureIssue = await this.getOcrFixtureIssue();
      if (ocrFixtureIssue) {
        throw new RetrievalEvaluationInvalidSettingsError(ocrFixtureIssue);
      }
      if (context.ocr) {
        const modelIssue = await this.getOcrModelFixtureIssue({
          context,
          organization,
          settingsOverrides,
        });
        if (modelIssue) {
          throw new RetrievalEvaluationInvalidSettingsError(modelIssue);
        }
      }
    }
    const suite = loadSuite();
    const componentFingerprints = buildComponentFingerprints({
      context,
      organization,
      suiteDigest: evaluationSuiteDigest(suite),
      settingsOverrides,
    });
    let run: RetrievalEvaluationRun;
    try {
      run = await RetrievalEvaluationRunModel.create({
        organizationId: params.organizationId,
        requestedByUserId: params.userId,
        name:
          params.name ??
          `Knowledge configuration evaluation ${new Date().toISOString().slice(0, 19).replace("T", " ")}`,
        queryLimit: params.queryLimit,
        selectedComponents,
        settingsOverrides,
        componentFingerprints: Object.fromEntries(
          selectedComponents.map((component) => [
            component,
            componentFingerprints[component],
          ]),
        ),
        progressMessage: "Waiting for an evaluation worker",
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const concurrent =
        await RetrievalEvaluationRunModel.findActiveByOrganization(
          params.organizationId,
        );
      if (concurrent) {
        throw new RetrievalEvaluationAlreadyRunningError(concurrent);
      }
      throw error;
    }

    try {
      const taskId = await this.enqueueRun(run.id);
      await RetrievalEvaluationRunModel.attachTask({ id: run.id, taskId });
      return (
        (await RetrievalEvaluationRunModel.findByIdForOrganization(
          run.id,
          params.organizationId,
        )) ?? run
      );
    } catch (error) {
      await RetrievalEvaluationRunModel.markFailed({
        id: run.id,
        error: summarize(error),
      });
      throw error;
    }
  }

  async listRuns(params: {
    organizationId: string;
    limit: number;
  }): Promise<RetrievalEvaluationRunSummary[]> {
    const runs = await RetrievalEvaluationRunModel.listByOrganization(params);
    return runs.map(({ artifact: _artifact, ...run }) => run);
  }

  async getRun(params: {
    organizationId: string;
    id: string;
  }): Promise<RetrievalEvaluationRun | null> {
    return RetrievalEvaluationRunModel.findByIdForOrganization(
      params.id,
      params.organizationId,
    );
  }

  async cancelRun(params: {
    organizationId: string;
    id: string;
  }): Promise<RetrievalEvaluationRun | null> {
    return RetrievalEvaluationRunModel.requestCancellation(params);
  }

  async compare(params: {
    organizationId: string;
    beforeId: string;
    afterId: string;
  }) {
    const [before, after] = await Promise.all([
      this.getRun({
        organizationId: params.organizationId,
        id: params.beforeId,
      }),
      this.getRun({
        organizationId: params.organizationId,
        id: params.afterId,
      }),
    ]);
    if (!before?.artifact || !after?.artifact) return null;
    const beforeArtifact = RunArtifactSchema.parse(before.artifact);
    const afterArtifact = RunArtifactSchema.parse(after.artifact);
    return compareRuns(beforeArtifact, afterArtifact);
  }

  async executeRun(runId: string): Promise<void> {
    if (!config.kb.evaluationEnabled) {
      await RetrievalEvaluationRunModel.markFailed({
        id: runId,
        error: "Knowledge configuration evaluation beta is disabled",
      });
      return;
    }
    const claim = await RetrievalEvaluationRunModel.claimForExecution(runId);
    if (claim.status === "missing" || claim.status === "terminal") return;
    if (claim.status === "busy") {
      const taskId = await this.enqueueRun(runId, 5_000);
      await RetrievalEvaluationRunModel.attachTask({ id: runId, taskId });
      return;
    }
    if (claim.status === "cancelled") {
      const run = await this.findRunWithoutOrganization(runId);
      if (run) await this.cleanupPersistedFixture(run);
      await RetrievalEvaluationRunModel.markCancelled(runId);
      return;
    }

    const run = claim.run;
    try {
      await this.cleanupPersistedFixture(run);
      const { corpus, golden, corpusDigest, goldenDigest } = loadSuite();
      const [savedExecutionContext, organization] = await Promise.all([
        inspectEvaluationContext(run.organizationId, run.settingsOverrides),
        OrganizationModel.getById(run.organizationId),
      ]);
      if (!organization) {
        throw new Error(`organization not found: ${run.organizationId}`);
      }
      const executionContext = applyEvaluationSettingsOverrides({
        context: savedExecutionContext,
        overrides: run.settingsOverrides,
      });
      const allFingerprints = buildComponentFingerprints({
        context: executionContext,
        organization,
        suiteDigest: evaluationSuiteDigest({ corpusDigest, goldenDigest }),
        settingsOverrides: run.settingsOverrides,
      });
      const componentFingerprints = Object.fromEntries(
        run.selectedComponents.map((component) => [
          component,
          allFingerprints[component],
        ]),
      );
      await RetrievalEvaluationRunModel.setComponentFingerprints({
        id: run.id,
        fingerprints: componentFingerprints,
      });
      const artifact = await runInstance({
        organizationId: run.organizationId,
        name: run.name,
        queryLimit: run.queryLimit,
        keepFixture: false,
        corpus,
        golden,
        corpusDigest,
        goldenDigest,
        selectedComponents: run.selectedComponents,
        componentFingerprints,
        settingsOverrides: run.settingsOverrides,
        control: {
          onProgress: (progress) =>
            RetrievalEvaluationRunModel.updateProgress({
              id: run.id,
              ...progress,
            }),
          shouldCancel: () =>
            RetrievalEvaluationRunModel.isCancellationRequested(run.id),
          onFixtureCreated: (fixture) =>
            RetrievalEvaluationRunModel.setFixture({
              id: run.id,
              knowledgeBaseId: fixture.knowledgeBaseId,
              connectorId: fixture.connectorId,
            }),
          onBm25Refreshed: () =>
            RetrievalEvaluationRunModel.markBm25Refreshed(run.id),
        },
      });
      if (!artifact.cleanup.completed) {
        await this.cleanupPersistedFixture(
          (await this.findRunWithoutOrganization(run.id)) ?? run,
        );
      }
      await RetrievalEvaluationRunModel.complete({ id: run.id, artifact });
    } catch (error) {
      if (error instanceof RetrievalEvaluationCancelledError) {
        try {
          const current = await this.findRunWithoutOrganization(run.id);
          if (current) await this.cleanupPersistedFixture(current);
          await RetrievalEvaluationRunModel.markCancelled(run.id);
        } catch (cleanupError) {
          await RetrievalEvaluationRunModel.markFailed({
            id: run.id,
            error: `Cancellation cleanup failed: ${summarize(cleanupError)}`,
          });
        }
        return;
      }
      logger.error(
        { runId: run.id, error },
        "Retrieval evaluation task failed",
      );
      let errorMessage = summarize(error);
      try {
        const current = await this.findRunWithoutOrganization(run.id);
        if (current) await this.cleanupPersistedFixture(current);
      } catch (cleanupError) {
        errorMessage += `; cleanup failed: ${summarize(cleanupError)}`;
      }
      await RetrievalEvaluationRunModel.markFailed({
        id: run.id,
        error: errorMessage,
      });
    }
  }

  // ===== Internal helpers =====

  private ocrFixtureIssuePromise: Promise<string | null> | null = null;
  private readonly ocrModelFixtureIssueCache = new LRUCacheManager<
    Promise<{ issue: string | null }>
  >({ maxSize: 100, defaultTtl: 60 * 60 * 1_000 });

  private getOcrFixtureIssue(): Promise<string | null> {
    this.ocrFixtureIssuePromise ??= inspectOcrFixture();
    return this.ocrFixtureIssuePromise;
  }

  private getOcrModelFixtureIssue(params: {
    context: Awaited<ReturnType<typeof inspectEvaluationContext>>;
    organization: NonNullable<
      Awaited<ReturnType<typeof OrganizationModel.getById>>
    >;
    settingsOverrides: RetrievalEvaluationSettingsOverrides;
  }): Promise<string | null> {
    const keyId =
      params.settingsOverrides.ocr?.chatApiKeyId ??
      params.organization.ocrChatApiKeyId;
    const model =
      params.settingsOverrides.ocr?.model ?? params.organization.ocrModel;
    if (!params.context.ocr || !keyId || !model) return Promise.resolve(null);

    const fixture = getOcrFixture();
    const cacheKey = fingerprint({
      organizationId: params.organization.id,
      keyId,
      model,
      fixtureDigest: digestFile(resolveAssetPath(fixture)),
    });
    let cached = this.ocrModelFixtureIssueCache.get(cacheKey);
    if (!cached) {
      cached = inspectOcrModelFixture({
        config: params.context.ocr,
        fixture,
      }).then((issue) => ({ issue }));
      this.ocrModelFixtureIssueCache.set(cacheKey, cached);
    }
    return cached.then(({ issue }) => issue);
  }

  private async enqueueRun(runId: string, delayMs = 0): Promise<string> {
    return taskQueueService.enqueue({
      taskType: "retrieval_evaluation",
      payload: { runId },
      maxAttempts: 3,
      ...(delayMs > 0 && {
        scheduledFor: new Date(Date.now() + delayMs),
      }),
    });
  }

  private async findRunWithoutOrganization(
    runId: string,
  ): Promise<RetrievalEvaluationRun | null> {
    // The task payload carries only a run id. Find it in the bounded recent set
    // through the model's internal identity lookup rather than trusting payload
    // organization data.
    return RetrievalEvaluationRunModel.findById(runId);
  }

  private async cleanupPersistedFixture(
    run: RetrievalEvaluationRun,
  ): Promise<void> {
    if (!run.fixtureKnowledgeBaseId || !run.fixtureConnectorId) return;
    await cleanupEvalFixtureByIds({
      organizationId: run.organizationId,
      knowledgeBaseId: run.fixtureKnowledgeBaseId,
      connectorId: run.fixtureConnectorId,
      refreshBm25: run.bm25Refreshed,
    });
    await RetrievalEvaluationRunModel.clearFixture(run.id);
  }
}

export const retrievalEvaluationService = new RetrievalEvaluationService();

// ===== Internal helpers =====

async function inspectOcrFixture(): Promise<string | null> {
  try {
    const fixture = getOcrFixture();
    const encoded = fs.readFileSync(resolveAssetPath(fixture), "utf8").trim();
    const result = await parsePdfBuffer(Buffer.from(encoded, "base64"));
    if (result.status === "no_text_layer" && result.pageCount === 1)
      return null;

    return `The evaluator OCR fixture is invalid: ${result.error ?? `expected one image-only page, received ${result.status}`}.`;
  } catch (error) {
    return `The evaluator OCR fixture could not be validated: ${summarize(error)}.`;
  }
}

async function inspectOcrModelFixture(params: {
  config: OcrConfig;
  fixture: ReturnType<typeof getOcrFixture>;
}): Promise<string | null> {
  const encoded = fs
    .readFileSync(resolveAssetPath(params.fixture), "utf8")
    .trim();
  const result = await extractPdfText({
    buffer: Buffer.from(encoded, "base64"),
    filename: params.fixture.asset,
    ocr: {
      config: params.config,
      connectorId: null,
      deadlineAt: Date.now() + 120_000,
      budget: { remainingPages: 1 },
      connectorType: "evaluation-preflight",
    },
  });
  if (
    ocrOutputContainsExpected({
      output: result.text,
      expected: params.fixture.content ?? "",
    })
  ) {
    return null;
  }

  return "The selected OCR model could not read the evaluator's scanned PDF reference code. Choose a model with working PDF or image understanding.";
}

function getOcrFixture() {
  const fixture = loadCorpus().find((document) => document.kind === "ocr-pdf");
  if (!fixture) throw new Error("The evaluator OCR fixture is missing");
  return fixture;
}

function loadSuite() {
  const corpus = loadCorpus(DEFAULT_CORPUS_PATH);
  const golden = loadGolden(DEFAULT_GOLDEN_PATH);
  assertGoldenMatchesCorpus(golden, corpus);
  const assetDigests = corpus
    .filter((document) => document.asset)
    .map((document) => ({
      id: document.id,
      digest: digestFile(resolveAssetPath(document)),
    }));
  return {
    corpus,
    golden,
    corpusDigest: fingerprint({
      manifest: digestFile(DEFAULT_CORPUS_PATH),
      assets: assetDigests,
    }),
    goldenDigest: digestFile(DEFAULT_GOLDEN_PATH),
  };
}

function evaluationSuiteDigest(params: {
  corpusDigest: string;
  goldenDigest: string;
}): string {
  return fingerprint({
    corpusDigest: params.corpusDigest,
    goldenDigest: params.goldenDigest,
  });
}

function summarize(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertRequestedSettingsAvailable(params: {
  context: Awaited<ReturnType<typeof inspectEvaluationContext>>;
  settingsOverrides: RetrievalEvaluationSettingsOverrides;
}): void {
  if (params.settingsOverrides.embedding && !params.context.embedding) {
    throw new RetrievalEvaluationInvalidSettingsError(
      "Temporary embedding settings could not be resolved",
    );
  }
  if (params.settingsOverrides.reranker && !params.context.reranker) {
    throw new RetrievalEvaluationInvalidSettingsError(
      "Temporary reranking settings could not be resolved",
    );
  }
  if (params.settingsOverrides.ocr && !params.context.ocr) {
    throw new RetrievalEvaluationInvalidSettingsError(
      "Temporary OCR settings could not be resolved",
    );
  }
}

async function assertSettingsKeysAvailable(params: {
  organizationId: string;
  userId: string;
  settingsOverrides: RetrievalEvaluationSettingsOverrides;
}): Promise<void> {
  const requestedIds = new Set(
    [
      params.settingsOverrides.embedding?.chatApiKeyId,
      params.settingsOverrides.reranker?.chatApiKeyId,
      params.settingsOverrides.ocr?.chatApiKeyId,
    ].filter((id): id is string => id !== undefined),
  );
  if (requestedIds.size === 0) return;

  const teamIds = await TeamModel.getUserTeamIds(params.userId);
  const available = await LlmProviderApiKeyModel.getAvailableKeysForUser(
    params.organizationId,
    params.userId,
    teamIds,
    undefined,
    { includeSubscriptionInfo: true },
  );
  const allowedIds = new Set(
    available
      .filter((key) => key.subscriptionKind === null)
      .map((key) => key.id),
  );
  if ([...requestedIds].some((id) => !allowedIds.has(id))) {
    throw new RetrievalEvaluationInvalidSettingsError(
      "One or more temporary API keys are unavailable to this user",
    );
  }
}

function buildComponentFingerprints(params: {
  context: Awaited<ReturnType<typeof inspectEvaluationContext>>;
  organization: NonNullable<
    Awaited<ReturnType<typeof OrganizationModel.getById>>
  >;
  suiteDigest: string;
  settingsOverrides?: RetrievalEvaluationSettingsOverrides;
}): Record<KnowledgeEvaluationComponent, string> {
  const { context, organization } = params;
  const suiteDigest = `${params.suiteDigest}:policy-${EVALUATION_POLICY_VERSION}`;
  const embedding = {
    keyId:
      params.settingsOverrides?.embedding?.chatApiKeyId ??
      organization.embeddingChatApiKeyId,
    model:
      params.settingsOverrides?.embedding?.model ?? organization.embeddingModel,
    dimensions: context.embedding?.dimensions ?? null,
    inputModalities: context.embedding?.inputModalities ?? null,
  };
  const reranker = {
    keyId:
      params.settingsOverrides?.reranker?.chatApiKeyId ??
      organization.rerankerChatApiKeyId,
    model:
      params.settingsOverrides?.reranker?.model ?? organization.rerankerModel,
    kind: context.reranker?.kind ?? null,
  };
  return {
    chunking: fingerprint({
      suiteDigest,
      chunkSizeTokens: context.effectiveConfig.chunkSizeTokens,
    }),
    "text-embedding": fingerprint({ suiteDigest, ...embedding }),
    "image-embedding": fingerprint({ suiteDigest, ...embedding }),
    "keyword-ranking": fingerprint({
      suiteDigest,
      hybridSearchEnabled: context.effectiveConfig.hybridSearchEnabled,
      bm25K1: context.effectiveConfig.bm25K1,
      bm25B: context.effectiveConfig.bm25B,
      bm25RecallCap: context.effectiveConfig.bm25RecallCap,
    }),
    "hybrid-retrieval": fingerprint({
      suiteDigest,
      ...embedding,
      hybridSearchEnabled: context.effectiveConfig.hybridSearchEnabled,
      searchStatementTimeoutMillis:
        context.effectiveConfig.searchStatementTimeoutMillis,
    }),
    reranking: fingerprint({ suiteDigest, ...reranker }),
    "query-expansion": fingerprint({ suiteDigest, ...reranker }),
    "contextual-retrieval": fingerprint({
      suiteDigest,
      ...reranker,
      enabled: context.effectiveConfig.contextualRetrievalEnabled,
      mode: context.contextualRetrievalMode,
    }),
    "context-expansion": fingerprint({
      suiteDigest,
      radius: context.effectiveConfig.contextExpansionRadius,
    }),
    ocr: fingerprint({
      suiteDigest,
      keyId:
        params.settingsOverrides?.ocr?.chatApiKeyId ??
        organization.ocrChatApiKeyId,
      model: params.settingsOverrides?.ocr?.model ?? organization.ocrModel,
      maxPages: context.effectiveConfig.ocrMaxPagesPerDocument,
    }),
  };
}

function missingRequirementGuidance(params: {
  requires: EvalCapability[];
  capabilities: Record<EvalCapability, CapabilityState>;
}): string {
  return params.requires
    .filter((capability) => params.capabilities[capability].status !== "active")
    .map(capabilityRequirementGuidance)
    .join(" ");
}

function capabilityRequirementGuidance(capability: EvalCapability): string {
  switch (capability) {
    case "text-embedding":
      return "Configure a valid text embedding key and model.";
    case "image-embedding":
      return "Choose an embedding model that accepts images.";
    case "ocr":
      return "Configure a valid document OCR key and model.";
    case "hybrid-search":
      return "Ask a platform operator to enable hybrid search for this deployment.";
    case "bm25":
      return "BM25 statistics must be available for this deployment.";
    case "reranker":
      return "Configure a valid reranking model.";
    case "cross-encoder-reranker":
      return "Configure a cross-encoder reranking model.";
    case "llm-reranker":
      return "Configure a text-generating reranking model.";
    case "query-expansion":
      return "Configure a text-generating reranking model.";
    case "contextual-retrieval":
      return "Enable contextual retrieval and configure its models.";
    case "context-expansion":
      return "Set context expansion radius above zero.";
  }
}

function fingerprint(value: Record<string, unknown>): string {
  // codeql[js/insufficient-password-hash] This hashes configuration values,
  // including opaque API-key record IDs, for change detection—not passwords.
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
