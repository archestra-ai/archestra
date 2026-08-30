import { execFileSync } from "node:child_process";
import { type KnowledgeQueryPlan, queryService } from "@/knowledge-base/query";
import type { RerankDiagnostics } from "@/knowledge-base/reranker";
import KbChunkModel from "@/models/kb-chunk";
import type { RetrievalEvaluationSettingsOverrides } from "@/types";
import {
  applyEvaluationSettingsOverrides,
  type EvaluationContext,
  inactiveCapabilityReasons,
  inspectEvaluationContext,
} from "./capabilities";
import { componentDefinition } from "./components";
import {
  aggregate,
  aggregateBySegment,
  aggregateByTag,
  bootstrapUncertainty,
  type ReturnedChunk,
  scoreQuery,
} from "./metrics";
import type {
  CorpusDocument,
  EvalCapability,
  GoldenQuery,
  KnowledgeEvaluationComponent,
  QueryResult,
  RerankOutcome,
  RunArtifact,
  SkippedQuery,
} from "./schema";
import {
  EVALUATION_POLICY_VERSION,
  KNOWLEDGE_EVALUATION_COMPONENTS,
} from "./schema";
import {
  cleanupEvalFixture,
  createEvalFixture,
  EVAL_ACL,
  ingestCorpus,
  prepareBm25,
  type SeededCorpus,
} from "./seed";

interface RunInstanceOptions {
  organizationId: string;
  name?: string;
  queryLimit: number;
  keepFixture: boolean;
  corpus: CorpusDocument[];
  golden: GoldenQuery[];
  corpusDigest: string;
  goldenDigest: string;
  selectedComponents?: KnowledgeEvaluationComponent[];
  componentFingerprints?: Partial<Record<KnowledgeEvaluationComponent, string>>;
  settingsOverrides?: RetrievalEvaluationSettingsOverrides;
  control?: {
    onProgress?: (progress: {
      stage: "preparing" | "ingesting" | "ranking" | "querying" | "cleanup";
      current: number;
      total: number;
      message: string;
    }) => Promise<void> | void;
    shouldCancel?: () => Promise<boolean> | boolean;
    onFixtureCreated?: (fixture: {
      knowledgeBaseId: string;
      connectorId: string;
    }) => Promise<void> | void;
    onBm25Refreshed?: () => Promise<void> | void;
  };
}

export class RetrievalEvaluationCancelledError extends Error {
  constructor() {
    super("Retrieval evaluation cancelled");
    this.name = "RetrievalEvaluationCancelledError";
  }
}

/** Run the fixed suite against this pod's real configuration and connections. */
export async function runInstance(
  options: RunInstanceOptions,
): Promise<RunArtifact> {
  const selectedComponents = [
    ...new Set(
      options.selectedComponents ?? [...KNOWLEDGE_EVALUATION_COMPONENTS],
    ),
  ];
  if (selectedComponents.length === 0) {
    throw new Error("At least one knowledge component must be selected");
  }
  if (await options.control?.shouldCancel?.()) {
    throw new RetrievalEvaluationCancelledError();
  }
  const context = applyEvaluationSettingsOverrides({
    context: await inspectEvaluationContext(
      options.organizationId,
      options.settingsOverrides,
    ),
    overrides: options.settingsOverrides ?? {},
  });
  const selectedSet = new Set(selectedComponents);
  const selectedGolden = options.golden.filter((query) =>
    selectedSet.has(query.component),
  );
  const selectedDefinitions = selectedComponents.map(componentDefinition);
  const activeComponents = selectedDefinitions
    .filter(
      (definition) =>
        inactiveCapabilityReasons(definition.requires, context.capabilities)
          .length === 0,
    )
    .map((definition) => definition.id);
  const activeSet = new Set(activeComponents);
  const onlineCorpus = selectCorpus({
    corpus: options.corpus,
    components: activeComponents.filter(
      (component) => componentDefinition(component).mode === "online",
    ),
  });
  const onlineDocumentIds = new Set(
    onlineCorpus.map((document) => document.id),
  );
  const offlineCorpus = selectCorpus({
    corpus: options.corpus,
    components: activeComponents.filter(
      (component) => componentDefinition(component).mode === "offline",
    ),
  }).filter((document) => !onlineDocumentIds.has(document.id));
  const totalWork =
    onlineCorpus.length + offlineCorpus.length + selectedGolden.length;
  await checkpoint(options, {
    stage: "preparing",
    current: 0,
    total: totalWork,
    message: "Resolving selected Knowledge components",
  });
  const runName =
    options.name?.trim() ||
    `${context.organizationName} ${new Date().toISOString()}`;
  const warnings = relevantContextMessages({
    messages: context.warnings,
    selected: selectedSet,
  });
  const errors = selectedDefinitions.some(
    (definition) => definition.mode === "online",
  )
    ? [...context.errors]
    : [];
  const queries: QueryResult[] = [];
  const skippedQueries: SkippedQuery[] = [];
  let seeded: SeededCorpus | null = null;
  let bm25Refreshed = false;
  let cleanupCompleted = true;
  let cancellation: RetrievalEvaluationCancelledError | null = null;
  let chunkingCheck:
    | { status: "passed" | "failed"; detail: string }
    | undefined;

  if (activeComponents.length === 0) {
    for (const golden of selectedGolden) {
      skippedQueries.push({
        id: golden.id,
        component: golden.component,
        query: golden.query,
        requires: golden.requires,
        reasons: inactiveCapabilityReasons(
          golden.requires,
          context.capabilities,
        ),
      });
    }
    const componentResults = buildComponentResults({
      selectedComponents,
      context,
      queries,
      skippedQueries,
      chunkingCheck,
    });
    return artifact({
      options,
      runName,
      context,
      status: "blocked",
      seeded,
      queries,
      skippedQueries,
      warnings,
      errors,
      cleanupCompleted,
      componentResults,
    });
  }

  try {
    seeded = await createEvalFixture({
      context,
      runId: crypto.randomUUID(),
    });
    await options.control?.onFixtureCreated?.({
      knowledgeBaseId: seeded.knowledgeBaseId,
      connectorId: seeded.connectorId,
    });
    let ingested = 0;
    if (onlineCorpus.length > 0) {
      await ingestCorpus({
        context,
        seeded,
        corpus: onlineCorpus,
        embedDocuments: true,
        skipContextualRetrieval: !selectedSet.has("contextual-retrieval"),
        control: {
          beforeDocument: async ({ index, documentId }) => {
            await checkpoint(options, {
              stage: "ingesting",
              current: ingested + index,
              total: totalWork,
              message: `Ingesting ${documentId}`,
            });
          },
        },
      });
      ingested += onlineCorpus.length;
    }
    if (offlineCorpus.length > 0) {
      await ingestCorpus({
        context,
        seeded,
        corpus: offlineCorpus,
        embedDocuments: false,
        skipContextualRetrieval: true,
        control: {
          beforeDocument: async ({ index, documentId }) => {
            await checkpoint(options, {
              stage: "ingesting",
              current: ingested + index,
              total: totalWork,
              message: `Preparing offline fixture ${documentId}`,
            });
          },
        },
      });
      ingested += offlineCorpus.length;
    }
    warnings.push(...seeded.warnings);
    if (selectedSet.has("chunking") && activeSet.has("chunking")) {
      chunkingCheck = await evaluateChunking(seeded);
    }
    if (
      ["keyword-ranking", "hybrid-retrieval", "context-expansion"].some(
        (component) => activeSet.has(component as KnowledgeEvaluationComponent),
      )
    ) {
      await checkpoint(options, {
        stage: "ranking",
        current: ingested,
        total: totalWork,
        message: "Refreshing BM25 corpus statistics",
      });
      bm25Refreshed = await prepareBm25({
        context,
        connectorId: seeded.connectorId,
        force:
          selectedSet.has("keyword-ranking") ||
          selectedSet.has("context-expansion"),
      });
      if (bm25Refreshed) await options.control?.onBm25Refreshed?.();
    }

    const rawChunks = await loadRawChunks(seeded);
    for (const [queryIndex, golden] of selectedGolden.entries()) {
      await checkpoint(options, {
        stage: "querying",
        current: ingested + queryIndex,
        total: totalWork,
        message: `Running ${golden.id}`,
      });
      const reasons = inactiveCapabilityReasons(
        golden.requires,
        context.capabilities,
      );
      const missingDocuments = golden.expected
        .map((expected) => expected.doc)
        .filter((document) => !seeded?.documentIds.has(document));
      if (missingDocuments.length > 0) {
        reasons.push(
          `fixture documents not ingested: ${missingDocuments.join(", ")}`,
        );
      }
      if (reasons.length > 0) {
        skippedQueries.push({
          id: golden.id,
          component: golden.component,
          query: golden.query,
          requires: golden.requires,
          reasons,
        });
        continue;
      }

      const result = await runGoldenQuery({
        golden,
        organizationId: context.organizationId,
        connectorId: seeded.connectorId,
        queryLimit: options.queryLimit,
        rawChunks,
        offline: componentDefinition(golden.component).mode === "offline",
        evaluation: queryEvaluationOverrides(golden.component, context),
      });
      queries.push(result);
      if (result.stageFailures.length > 0) {
        warnings.push(`${golden.id}: ${result.stageFailures.join("; ")}`);
      }
    }
  } catch (error) {
    if (error instanceof RetrievalEvaluationCancelledError) {
      cancellation = error;
    } else {
      errors.push(summarize(error));
    }
  } finally {
    if (seeded && !options.keepFixture) {
      try {
        await options.control?.onProgress?.({
          stage: "cleanup",
          current: totalWork,
          total: totalWork,
          message: "Removing evaluation fixtures",
        });
      } catch (error) {
        errors.push(`cleanup progress update failed: ${summarize(error)}`);
      }
      try {
        await cleanupEvalFixture({
          organizationId: context.organizationId,
          seeded,
          refreshBm25: bm25Refreshed,
        });
      } catch (error) {
        cleanupCompleted = false;
        errors.push(`fixture cleanup failed: ${summarize(error)}`);
      }
    }
  }

  if (cancellation) throw cancellation;

  const relevantCapabilities = new Set<EvalCapability>(
    selectedDefinitions.flatMap((definition) => definition.requires),
  );
  for (const [capability, state] of Object.entries(context.capabilities)) {
    if (!relevantCapabilities.has(capability as EvalCapability)) continue;
    if (state.status !== "unavailable") continue;
    const message = `${capability} is unavailable: ${state.detail}`;
    if (!warnings.includes(message)) warnings.push(message);
  }
  const failedExpectations = queries.filter((query) => !query.passed).length;
  if (failedExpectations > 0) {
    warnings.push(
      `${failedExpectations} applicable test case(s) missed their expected result or stage contract`,
    );
  }
  const componentResults = buildComponentResults({
    selectedComponents,
    context,
    queries,
    skippedQueries,
    chunkingCheck,
  });
  const passedComponents = componentResults.filter(
    (result) => result.status === "passed",
  ).length;
  const incompleteComponents = componentResults.filter(
    (result) => result.status !== "passed",
  ).length;
  const status: RunArtifact["status"] =
    errors.length > 0 || passedComponents === 0
      ? "blocked"
      : warnings.length > 0 ||
          failedExpectations > 0 ||
          incompleteComponents > 0
        ? "degraded"
        : "completed";

  return artifact({
    options,
    runName,
    context,
    status,
    seeded,
    queries,
    skippedQueries,
    warnings,
    errors,
    cleanupCompleted,
    componentResults,
  });
}

// ===== Internal helpers =====

type ComponentResult = NonNullable<
  RunArtifact["selection"]
>["componentResults"][number];

type QueryEvaluationOverrides = NonNullable<
  Parameters<typeof queryService.query>[0]["evaluation"]
>;

function selectCorpus(params: {
  corpus: CorpusDocument[];
  components: KnowledgeEvaluationComponent[];
}): CorpusDocument[] {
  if (params.components.length === 0) return [];
  const ids = new Set(
    params.components.flatMap((component) => COMPONENT_DOCUMENT_IDS[component]),
  );
  const selected = params.corpus.filter((document) => ids.has(document.id));
  return selected.length > 0 ? selected : params.corpus;
}

function queryEvaluationOverrides(
  component: KnowledgeEvaluationComponent,
  context: EvaluationContext,
): QueryEvaluationOverrides {
  return {
    hybridSearchEnabled: component === "hybrid-retrieval",
    queryExpansionEnabled: component === "query-expansion",
    rerankingEnabled: component === "reranking",
    contextExpansionEnabled: false,
    bm25: {
      k1: Number(context.effectiveConfig.bm25K1),
      b: Number(context.effectiveConfig.bm25B),
    },
    ...(context.embedding ? { embedding: context.embedding } : {}),
    ...(context.reranker ? { reranker: context.reranker } : {}),
  };
}

async function evaluateChunking(
  seeded: SeededCorpus,
): Promise<{ status: "passed" | "failed"; detail: string }> {
  const documentId = seeded.documentIds.get("zephyr-handbook");
  if (!documentId) {
    return { status: "failed", detail: "Chunking fixture was not ingested" };
  }
  const chunks = await KbChunkModel.findByDocument(documentId);
  return chunks.length > 1
    ? {
        status: "passed",
        detail: `Production chunker produced ${chunks.length} chunks`,
      }
    : {
        status: "failed",
        detail: `Expected a multi-chunk document, received ${chunks.length} chunk`,
      };
}

function buildComponentResults(params: {
  selectedComponents: KnowledgeEvaluationComponent[];
  context: Awaited<ReturnType<typeof inspectEvaluationContext>>;
  queries: QueryResult[];
  skippedQueries: SkippedQuery[];
  chunkingCheck?: { status: "passed" | "failed"; detail: string };
}): ComponentResult[] {
  return params.selectedComponents.map((component) => {
    const definition = componentDefinition(component);
    const reasons = inactiveCapabilityReasons(
      definition.requires,
      params.context.capabilities,
    );
    if (reasons.length > 0) {
      return {
        component,
        mode: definition.mode,
        status: "skipped",
        detail: definition.unavailableDescription,
      };
    }
    if (component === "chunking") {
      return {
        component,
        mode: definition.mode,
        status: params.chunkingCheck?.status ?? "failed",
        detail:
          params.chunkingCheck?.detail ?? "Chunking check did not complete",
      };
    }
    const results = params.queries.filter(
      (query) => query.component === component,
    );
    if (results.length > 0) {
      const failed = results.filter((query) => !query.passed).length;
      const measuredOnly = results.filter(
        (query) => query.gateMode === "metric-only",
      ).length;
      const gated = results.length - measuredOnly;
      return {
        component,
        mode: definition.mode,
        status: failed === 0 ? "passed" : "failed",
        detail:
          failed === 0
            ? [
                gated > 0 ? `${gated} gated test case(s) passed` : null,
                measuredOnly > 0
                  ? `${measuredOnly} test case(s) measured only`
                  : null,
              ]
                .filter((detail): detail is string => detail !== null)
                .join("; ")
            : `${failed} of ${results.length} test case(s) failed`,
      };
    }
    const skipped = params.skippedQueries.filter(
      (query) => query.component === component,
    );
    return {
      component,
      mode: definition.mode,
      status: "skipped",
      detail:
        skipped.length > 0
          ? definition.unavailableDescription
          : "No test case ran for this component",
    };
  });
}

function relevantContextMessages(params: {
  messages: string[];
  selected: Set<KnowledgeEvaluationComponent>;
}): string[] {
  return params.messages.filter((message) => {
    if (message.startsWith("reranker configuration")) {
      return ["reranking", "query-expansion", "contextual-retrieval"].some(
        (component) =>
          params.selected.has(component as KnowledgeEvaluationComponent),
      );
    }
    if (message.startsWith("OCR configuration")) {
      return params.selected.has("ocr");
    }
    return true;
  });
}

const COMPONENT_DOCUMENT_IDS: Record<KnowledgeEvaluationComponent, string[]> = {
  chunking: ["zephyr-handbook"],
  "text-embedding": [
    "asterline-canary",
    "aurora-transfer-v1",
    "aurora-transfer-v2",
    "calypso-reconciliation-runbook",
    "nimbus-spanish-runbook",
    "mercury-release-calendar",
    "mercury-support-roster",
    "polaris-retention-copy-a",
    "polaris-retention-copy-b",
  ],
  "image-embedding": ["multimodal-lobster"],
  "keyword-ranking": [
    "cedar-primary",
    "cedar-distractor",
    "glacier-ack-protocol",
    "glacier-rollback-protocol",
    "kepler-reseed-runbook",
    "kepler-reseed-glossary",
    "cirrus-receipt-ledger",
  ],
  "hybrid-retrieval": ["raven-runbook", "raven-inventory"],
  reranking: ["meridian-procedure", "meridian-glossary"],
  "query-expansion": ["asterline-canary"],
  "contextual-retrieval": ["orion-change-log"],
  "context-expansion": ["zephyr-handbook"],
  ocr: ["ocr-nebula-contract"],
};

async function runGoldenQuery(params: {
  golden: GoldenQuery;
  organizationId: string;
  connectorId: string;
  queryLimit: number;
  rawChunks: Map<string, string>;
  offline: boolean;
  evaluation: QueryEvaluationOverrides;
}): Promise<QueryResult> {
  const { golden } = params;
  let plan: KnowledgeQueryPlan = {
    expandedQueryCount: 1,
    expandedQueryTypes: ["semantic"],
    keywordRanker: "disabled",
  };
  let reranker: RerankOutcome = {
    status: "disabled",
    kind: null,
    provider: null,
    model: null,
    changedOrder: false,
    filteredCount: 0,
    error: null,
  };
  let rankingScores: Array<{ doc: string; ref: string; score: number }> = [];
  const started = performance.now();
  const diagnostics = {
    onPlan: (observed: KnowledgeQueryPlan) => {
      plan = observed;
    },
    onRerank: (observed: RerankDiagnostics) => {
      reranker = mapRerankOutcome(observed);
    },
    onKeywordResults: (
      observed: Array<{
        documentId: string;
        chunkIndex: number;
        sourceId: string | null;
        score: number;
      }>,
    ) => {
      rankingScores = observed.map((result) => {
        const doc = result.sourceId ?? `<no source id: ${result.documentId}>`;
        return {
          doc,
          ref: `${doc}#${result.chunkIndex}`,
          score: result.score,
        };
      });
    },
  };
  const chunks = params.offline
    ? await queryService.queryKeywordOnly({
        connectorIds: [params.connectorId],
        organizationId: params.organizationId,
        queryText: golden.query,
        userAcl: [...EVAL_ACL],
        environmentId: null,
        limit: params.queryLimit,
        expandContext: golden.component === "context-expansion",
        diagnostics,
        bm25: params.evaluation.bm25,
      })
    : await queryService.query({
        connectorIds: [params.connectorId],
        organizationId: params.organizationId,
        queryText: golden.query,
        userAcl: [...EVAL_ACL],
        environmentId: null,
        limit: params.queryLimit,
        diagnostics,
        evaluation: params.evaluation,
      });
  const latencyMs = Math.round(performance.now() - started);
  const returned: ReturnedChunk[] = chunks.map((chunk) => {
    const doc =
      chunk.citation.sourceId ?? `<no source id: ${chunk.citation.documentId}>`;
    return {
      doc,
      ref: `${doc}#${chunk.chunkIndex}`,
      content: chunk.content,
    };
  });
  const contextExpanded = chunks.some((chunk) => {
    if (chunk.media) return false;
    const raw = params.rawChunks.get(
      `${chunk.citation.documentId}#${chunk.chunkIndex}`,
    );
    return raw !== undefined && raw !== chunk.content;
  });
  const { metrics, firstRank } = scoreQuery(golden, returned);
  const expectedAtK = String(golden.expectAtK);
  const stageFailures = stageFailuresFor({
    golden,
    plan,
    reranker,
    contextExpanded,
  });
  const evidence = metrics.evidence[expectedAtK];
  const qualityPassed =
    metrics.recall[expectedAtK] === 1 &&
    (evidence === null || evidence === undefined || evidence === 1) &&
    (metrics.negativeHit?.[expectedAtK] === null ||
      metrics.negativeHit?.[expectedAtK] === undefined ||
      metrics.negativeHit?.[expectedAtK] === 0) &&
    stageFailures.length === 0;
  const passed =
    golden.gateMode === "metric-only"
      ? stageFailures.length === 0
      : qualityPassed;

  return {
    id: golden.id,
    component: golden.component,
    query: golden.query,
    tags: golden.tags,
    category: golden.category ?? "general",
    language: golden.language ?? "en",
    difficulty: golden.difficulty ?? "medium",
    answerability: golden.answerability ?? "answerable",
    gateMode: golden.gateMode ?? "pass-fail",
    requires: golden.requires,
    expectAtK: golden.expectAtK,
    expected: golden.expected.map((expected) => expected.doc),
    forbidden: golden.forbidden ?? [],
    returned: returned.map(({ doc, ref }) => ({ doc, ref })),
    firstRank,
    latencyMs,
    metrics,
    passed,
    stageFailures,
    stages: {
      expandedQueryCount: plan.expandedQueryCount,
      expandedQueryTypes: plan.expandedQueryTypes,
      keywordRanker: plan.keywordRanker,
      reranker,
      contextExpanded,
      rankingScores,
    },
  };
}

function stageFailuresFor(params: {
  golden: GoldenQuery;
  plan: KnowledgeQueryPlan;
  reranker: RerankOutcome;
  contextExpanded: boolean;
}): string[] {
  const failures: string[] = [];
  const requires = new Set(params.golden.requires);
  if (
    requires.has("hybrid-search") &&
    params.plan.keywordRanker === "disabled"
  ) {
    failures.push("hybrid search was required but no keyword lane ran");
  }
  if (requires.has("bm25") && params.plan.keywordRanker !== "bm25") {
    failures.push(
      `BM25 was required but ${params.plan.keywordRanker} ranked keywords`,
    );
  }
  if (requires.has("query-expansion") && params.plan.expandedQueryCount <= 1) {
    failures.push(
      "query expansion was configured but produced no additional query",
    );
  }
  if (requires.has("reranker") && params.reranker.status !== "succeeded") {
    failures.push(`reranker outcome was ${params.reranker.status}`);
  }
  if (
    requires.has("cross-encoder-reranker") &&
    params.reranker.kind !== "native-rerank"
  ) {
    failures.push("the native cross-encoder reranker did not run");
  }
  if (requires.has("llm-reranker") && params.reranker.kind !== "llm") {
    failures.push("the LLM reranker did not run");
  }
  if (requires.has("context-expansion") && !params.contextExpanded) {
    failures.push("the returned hit contained no neighboring chunk context");
  }
  return failures;
}

async function loadRawChunks(
  seeded: SeededCorpus,
): Promise<Map<string, string>> {
  const raw = new Map<string, string>();
  for (const documentId of seeded.documentIds.values()) {
    for (const chunk of await KbChunkModel.findByDocument(documentId)) {
      raw.set(`${documentId}#${chunk.chunkIndex}`, chunk.content);
    }
  }
  return raw;
}

function mapRerankOutcome(observed: RerankDiagnostics): RerankOutcome {
  return {
    status: observed.status,
    kind: observed.kind,
    provider: observed.provider,
    model: observed.model,
    changedOrder: observed.changedOrder,
    filteredCount: observed.filteredCount,
    error: observed.error,
  };
}

function artifact(params: {
  options: RunInstanceOptions;
  runName: string;
  context: Awaited<ReturnType<typeof inspectEvaluationContext>>;
  status: RunArtifact["status"];
  seeded: SeededCorpus | null;
  queries: QueryResult[];
  skippedQueries: SkippedQuery[];
  warnings: string[];
  errors: string[];
  cleanupCompleted: boolean;
  componentResults: ComponentResult[];
}): RunArtifact {
  const { context, seeded } = params;
  return {
    schemaVersion: 2,
    status: params.status,
    run: {
      name: params.runName,
      organizationId: context.organizationId,
      queryLimit: params.options.queryLimit,
    },
    fingerprint: {
      platformVersion: process.env.ARCHESTRA_VERSION ?? "development",
      gitSha: git(["rev-parse", "HEAD"]),
      gitDirty: gitDirty(),
      corpusDigest: params.options.corpusDigest,
      goldenDigest: params.options.goldenDigest,
      effectiveConfig: {
        ...context.effectiveConfig,
        evaluationPolicyVersion: EVALUATION_POLICY_VERSION,
      },
      embedding: context.embedding
        ? {
            provider: context.embedding.provider,
            model: context.embedding.model,
            dimensions: context.embedding.dimensions,
            inputModalities: context.embedding.inputModalities,
          }
        : null,
      reranker: context.reranker
        ? {
            provider: context.reranker.provider,
            model: context.reranker.modelName,
            kind: context.reranker.kind,
          }
        : null,
      ocr: context.ocr
        ? { provider: context.ocr.provider, model: context.ocr.modelName }
        : null,
    },
    capabilities: context.capabilities,
    ingest: {
      documents: seeded?.documents ?? 0,
      chunks: seeded?.chunks ?? 0,
      textDocuments: seeded?.textDocuments ?? 0,
      imageDocuments: seeded?.imageDocuments ?? 0,
      ocrDocuments: seeded?.ocrDocuments ?? 0,
      contextualizedChunks: seeded?.contextualizedChunks ?? 0,
      wallMs: seeded?.wallMs ?? 0,
    },
    queries: params.queries,
    skippedQueries: params.skippedQueries,
    aggregates: aggregate(params.queries),
    byTag: aggregateByTag(params.queries),
    bySegment: aggregateBySegment(params.queries),
    uncertainty: bootstrapUncertainty({
      results: params.queries,
      seed: `${params.options.corpusDigest}:${params.options.goldenDigest}:policy-${EVALUATION_POLICY_VERSION}`,
    }),
    cleanup: {
      kept: params.options.keepFixture,
      knowledgeBaseId: params.options.keepFixture
        ? (seeded?.knowledgeBaseId ?? null)
        : null,
      connectorId: params.options.keepFixture
        ? (seeded?.connectorId ?? null)
        : null,
      completed: params.options.keepFixture ? false : params.cleanupCompleted,
    },
    selection: {
      components: [
        ...new Set(
          params.options.selectedComponents ?? [
            ...KNOWLEDGE_EVALUATION_COMPONENTS,
          ],
        ),
      ],
      componentFingerprints: params.options.componentFingerprints ?? {},
      componentResults: params.componentResults,
    },
    warnings: params.warnings,
    errors: params.errors,
  };
}

function gitDirty(): boolean | null {
  const status = git(["status", "--porcelain", "--untracked-files=no"]);
  return status === null ? null : status.length > 0;
}

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function summarize(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function checkpoint(
  options: RunInstanceOptions,
  progress: {
    stage: "preparing" | "ingesting" | "ranking" | "querying" | "cleanup";
    current: number;
    total: number;
    message: string;
  },
): Promise<void> {
  if (await options.control?.shouldCancel?.()) {
    throw new RetrievalEvaluationCancelledError();
  }
  await options.control?.onProgress?.(progress);
}
