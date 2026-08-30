"use client";

import {
  type archestraApiTypes,
  BM25_B_MAX,
  BM25_B_MIN,
  BM25_K1_MAX,
  BM25_K1_MIN,
  type ContextualRetrievalMode,
  DocsPage,
  getDocsUrl,
  isSupportedProvider,
  type SupportedProvider,
} from "@archestra/shared";
import type { ColumnDef, RowSelectionState } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  CircleCheck,
  CircleX,
  Download,
  Info,
  Loader2,
  Minus,
  Square,
  X,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { ProviderIcon } from "@/components/provider-icon";
import { WithPermissions } from "@/components/roles/with-permissions";
import { StandardDialog } from "@/components/standard-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DataTable } from "@/components/ui/data-table";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { WizardStepper } from "@/components/wizard-stepper";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import {
  useTestEmbeddingConnection,
  useTestOcrConnection,
  useTestRerankerConnection,
} from "@/lib/organization.query";
import {
  useCancelRetrievalEvaluation,
  useRetrievalEvaluationCapabilities,
  useRetrievalEvaluationCapabilitiesPreview,
  useRetrievalEvaluationComparison,
  useRetrievalEvaluationRun,
  useRetrievalEvaluationRuns,
  useStartRetrievalEvaluation,
} from "@/lib/retrieval-evaluation.query";
import { cn } from "@/lib/utils";
import {
  KnowledgeConfigurationFields,
  KnowledgeConnectionActions,
} from "./knowledge-settings-fields";
import type { SectionStatus } from "./knowledge-validation";

type Capabilities =
  archestraApiTypes.GetRetrievalEvaluationCapabilitiesResponses["200"];
type ComponentInfo = Capabilities["components"][number];
type ComponentId = ComponentInfo["id"];
type RunSummary =
  archestraApiTypes.ListRetrievalEvaluationRunsResponses["200"][number];
type RunDetail = archestraApiTypes.GetRetrievalEvaluationRunResponses["200"];
type EvaluationComparison =
  archestraApiTypes.CompareRetrievalEvaluationsResponses["200"];
type ComparisonQuery = EvaluationComparison["queries"][number];
type ComparisonDirection = "improved" | "regressed" | "same";
type EvaluationModelPair = {
  chatApiKeyId: string | null;
  model: string | null;
};
type EvaluationSettingsOverrides = NonNullable<
  archestraApiTypes.StartRetrievalEvaluationData["body"]["settingsOverrides"]
>;
type StartWizardStep = "configuration" | "checks";
type EvaluationConfigurationTarget =
  | "embedding"
  | "keyword-ranking"
  | "reranking"
  | "contextual-retrieval"
  | "ocr";
type EvaluationConfigurationIssue = {
  detail: string;
  targets: EvaluationConfigurationTarget[];
};

const START_WIZARD_STEPS: ReadonlyArray<{
  id: StartWizardStep;
  title: string;
}> = [
  { id: "configuration", title: "Configuration" },
  { id: "checks", title: "Checks" },
];

const START_WIZARD_STEP_DESCRIPTIONS: Record<StartWizardStep, string> = {
  configuration: "Confirm the Knowledge configuration for this run.",
  checks: "Choose the evaluation checks to run.",
};

const EVALUATION_CONFIGURATION_TARGETS: Record<
  EvaluationConfigurationTarget,
  { href: string; wizardId: string; label: string }
> = {
  embedding: {
    href: "#embedding-configuration",
    wizardId: "evaluation-embedding-configuration",
    label: "Configure embedding",
  },
  "keyword-ranking": {
    href: "#keyword-ranking",
    wizardId: "evaluation-keyword-ranking",
    label: "Configure keyword ranking",
  },
  reranking: {
    href: "#reranking-configuration",
    wizardId: "evaluation-reranking-configuration",
    label: "Configure reranking",
  },
  "contextual-retrieval": {
    href: "#contextual-retrieval",
    wizardId: "evaluation-contextual-retrieval",
    label: "Configure contextual retrieval",
  },
  ocr: {
    href: "#document-ocr",
    wizardId: "evaluation-document-ocr",
    label: "Configure OCR",
  },
};

const EVALUATION_COMPONENTS_BY_CONFIGURATION = {
  embedding: ["text-embedding", "image-embedding", "hybrid-retrieval"],
  "keyword-ranking": ["keyword-ranking"],
  reranking: ["reranking", "query-expansion", "contextual-retrieval"],
  "contextual-retrieval": ["contextual-retrieval"],
  ocr: ["ocr"],
} satisfies Record<EvaluationConfigurationTarget, ComponentId[]>;

const TERMINAL_WITH_ARTIFACT = new Set(["completed", "degraded", "blocked"]);
const EVALUATION_METRICS_DOCS_URL = getDocsUrl(
  DocsPage.PlatformKnowledge,
  "evaluation-metrics",
);
const HIT_AT_5_DOCS_URL = getDocsUrl(DocsPage.PlatformKnowledge, "hit-at-5");
const MRR_DOCS_URL = getDocsUrl(
  DocsPage.PlatformKnowledge,
  "mean-reciprocal-rank-mrr",
);
const BM25_SCORE_GAP_DOCS_URL = getDocsUrl(
  DocsPage.PlatformKnowledge,
  "bm25-score-gap",
);

export function RetrievalEvaluationSection({
  bm25K1,
  bm25B,
  embeddingChatApiKeyId,
  embeddingModel,
  rerankerChatApiKeyId,
  rerankerModel,
  ocrChatApiKeyId,
  ocrModel,
  contextualRetrievalMode,
  onAddApiKey,
}: {
  bm25K1: number;
  bm25B: number;
  embeddingChatApiKeyId: string | null;
  embeddingModel: string | null;
  rerankerChatApiKeyId: string | null;
  rerankerModel: string | null;
  ocrChatApiKeyId: string | null;
  ocrModel: string | null;
  contextualRetrievalMode: ContextualRetrievalMode;
  onAddApiKey: (purpose: "embedding" | "reranking" | "ocr") => void;
}) {
  const capabilities = useRetrievalEvaluationCapabilities();
  const runsQuery = useRetrievalEvaluationRuns();
  const start = useStartRetrievalEvaluation();
  const cancel = useCancelRetrievalEvaluation();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [completedRunToOpen, setCompletedRunToOpen] = useState<string | null>(
    null,
  );
  const [comparisonIds, setComparisonIds] = useState<{
    beforeId: string;
    afterId: string;
  } | null>(null);
  const refreshedTerminalRun = useRef<string | null>(null);
  const previousActiveRunIds = useRef<Set<string> | null>(null);
  const completedRunQuery = useRetrievalEvaluationRun(completedRunToOpen);

  const capabilityData = capabilities.data;
  const recommendedComponentIds = useMemo(
    () =>
      capabilityData?.components
        .filter(
          (component) =>
            component.status === "active" && component.selectedByDefault,
        )
        .map((component) => component.id) ?? [],
    [capabilityData],
  );
  const initialEmbedding = useMemo(
    () => ({ chatApiKeyId: embeddingChatApiKeyId, model: embeddingModel }),
    [embeddingChatApiKeyId, embeddingModel],
  );
  const initialReranker = useMemo(
    () => ({ chatApiKeyId: rerankerChatApiKeyId, model: rerankerModel }),
    [rerankerChatApiKeyId, rerankerModel],
  );
  const initialOcr = useMemo(
    () => ({ chatApiKeyId: ocrChatApiKeyId, model: ocrModel }),
    [ocrChatApiKeyId, ocrModel],
  );
  const runs = runsQuery.data ?? [];
  const activeRun = runs.find((run) => isActive(run.status)) ?? null;
  const latestFinishedRun = runs.find((run) => !isActive(run.status)) ?? null;
  const comparableRuns = runs.filter((run) =>
    TERMINAL_WITH_ARTIFACT.has(run.status),
  );

  useEffect(() => {
    const activeIds = new Set(
      runs.filter((run) => isActive(run.status)).map((run) => run.id),
    );
    const previous = previousActiveRunIds.current;
    previousActiveRunIds.current = activeIds;
    if (!previous) return;

    const finished = runs.find(
      (run) => !isActive(run.status) && previous.has(run.id),
    );
    if (!finished || refreshedTerminalRun.current === finished.id) return;

    refreshedTerminalRun.current = finished.id;
    void capabilities.refetch();
    setWizardOpen(false);
    setCompletedRunToOpen(finished.id);
  }, [runs, capabilities]);
  useEffect(() => {
    if (
      !completedRunToOpen ||
      !completedRunQuery.data ||
      isActive(completedRunQuery.data.status)
    ) {
      return;
    }
    setSelectedRunId(completedRunToOpen);
    setCompletedRunToOpen(null);
  }, [completedRunQuery.data, completedRunToOpen]);

  const handleStart = async ({
    components,
    settingsOverrides,
  }: {
    components: ComponentId[];
    settingsOverrides: EvaluationSettingsOverrides;
  }) => {
    const run = await start.mutateAsync({
      queryLimit: 10,
      components,
      settingsOverrides,
    });
    if (!run) return;
    setWizardOpen(false);
    setSelectedRunId(run.id);
  };

  const handleCompareLatest = () => {
    if (comparableRuns.length < 2) return;
    setComparisonIds({
      beforeId: comparableRuns[1].id,
      afterId: comparableRuns[0].id,
    });
  };
  return (
    <section id="knowledge-configuration-evaluation" className="space-y-4">
      {capabilities.isError && (
        <Alert variant="destructive">
          <CircleX />
          <AlertTitle>Could not load evaluation checks</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <p>Check your connection, then try again.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void capabilities.refetch()}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {runsQuery.isError && (
        <Alert variant="destructive">
          <CircleX />
          <AlertTitle>Could not load recent evaluations</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <p>Check your connection, then try again.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void runsQuery.refetch()}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {activeRun && (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3">
          <div className="flex items-center justify-between gap-3">
            <Button
              type="button"
              variant="ghost"
              className="h-auto min-w-0 flex-1 justify-start p-0 text-left hover:bg-transparent"
              aria-label={`View ${activeRun.name}, ${statusLabel(activeRun.status)}`}
              onClick={() => setSelectedRunId(activeRun.id)}
            >
              <span className="truncate text-xs">
                {activeRun.status === "queued"
                  ? "Waiting to start"
                  : activeRun.status === "cancel_requested"
                    ? "Stopping evaluation"
                    : (activeRun.progressMessage ?? "Evaluation running")}
              </span>
            </Button>
            <div className="flex shrink-0 items-center gap-3">
              <span
                className="text-xs text-muted-foreground"
                aria-live="polite"
              >
                {activeRun.status === "running"
                  ? `${progressPercent(activeRun)}%`
                  : statusLabel(activeRun.status)}
              </span>
              {activeRun.status !== "cancel_requested" && (
                <WithPermissions
                  permissions={{ knowledgeSettings: ["update"] }}
                  noPermissionHandle="tooltip"
                >
                  {({ hasPermission }) => (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                      disabled={!hasPermission || cancel.isPending}
                      onClick={() => cancel.mutate(activeRun.id)}
                    >
                      {cancel.isPending ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Square className="size-3.5" />
                      )}
                      <span>Cancel evaluation</span>
                    </Button>
                  )}
                </WithPermissions>
              )}
            </div>
          </div>
          {activeRun.status === "running" ? (
            <Progress
              value={progressPercent(activeRun)}
              aria-label="Evaluation progress"
              className="h-1"
            />
          ) : (
            <div className="h-1 overflow-hidden rounded-full bg-primary/20">
              <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
            </div>
          )}
        </div>
      )}

      <div className="overflow-hidden rounded-md border">
        <div className="grid md:grid-cols-2">
          <section className="flex min-w-0 flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between md:border-r">
            <div className="min-w-0 space-y-1">
              <h3 className="text-sm font-medium">Latest evaluation</h3>
              {runsQuery.isLoading ? (
                <p className="text-sm text-muted-foreground">
                  Loading recent evaluations...
                </p>
              ) : latestFinishedRun ? (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                  <RunStatusText status={latestFinishedRun.status} />
                  {Object.keys(latestFinishedRun.settingsOverrides ?? {})
                    .length > 0 && <span>Temporary settings</span>}
                  <span>
                    {formatDistanceToNow(
                      new Date(latestFinishedRun.createdAt),
                      {
                        addSuffix: true,
                      },
                    )}
                  </span>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No evaluations have finished yet.
                </p>
              )}
            </div>
            {latestFinishedRun && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => setSelectedRunId(latestFinishedRun.id)}
              >
                View details
              </Button>
            )}
          </section>

          <section className="flex min-w-0 flex-col gap-3 border-t p-4 sm:flex-row sm:items-center sm:justify-between md:border-t-0">
            <div className="min-w-0 space-y-1">
              <h3 className="text-sm font-medium">Compare evaluations</h3>
              <p className="text-sm text-muted-foreground">
                {comparableRuns.length >= 2
                  ? "Review changes between the two most recent completed runs."
                  : comparableRuns.length === 1
                    ? "Complete one more run to compare settings and results."
                    : "Complete two runs to compare settings and results."}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={comparableRuns.length < 2}
              onClick={handleCompareLatest}
            >
              Compare latest
            </Button>
          </section>
        </div>

        {!capabilities.isError && (
          <section className="flex flex-col gap-4 border-t bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1">
              <h3 className="text-sm font-medium">Run an evaluation</h3>
              <p className="max-w-2xl text-sm text-muted-foreground">
                Test temporary Knowledge settings against new, changed, or
                manually selected checks.
              </p>
            </div>
            <WithPermissions
              permissions={{ knowledgeSettings: ["update"] }}
              noPermissionHandle="tooltip"
            >
              {({ hasPermission }) => (
                <Button
                  type="button"
                  className="shrink-0"
                  disabled={
                    !hasPermission ||
                    !capabilityData ||
                    activeRun !== null ||
                    start.isPending
                  }
                  onClick={() => setWizardOpen(true)}
                >
                  {start.isPending && (
                    <Loader2 className="size-3.5 animate-spin" />
                  )}
                  <span>Start evaluation</span>
                </Button>
              )}
            </WithPermissions>
          </section>
        )}
      </div>

      <StartEvaluationWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        components={capabilityData?.components ?? []}
        scenarios={capabilityData?.scenarios ?? []}
        initialSelectedComponents={recommendedComponentIds}
        pending={start.isPending}
        initialBm25K1={bm25K1}
        initialBm25B={bm25B}
        initialEmbedding={initialEmbedding}
        initialReranker={initialReranker}
        initialOcr={initialOcr}
        initialContextualRetrievalMode={contextualRetrievalMode}
        onAddApiKey={onAddApiKey}
        onConfirm={handleStart}
      />
      <RunDetailsDialog
        runId={selectedRunId}
        onClose={() => setSelectedRunId(null)}
        onCancel={(id) => cancel.mutate(id)}
        cancelling={cancel.isPending}
      />
      <ComparisonDialog
        ids={comparisonIds}
        onClose={() => setComparisonIds(null)}
      />
    </section>
  );
}

function EvaluationChecksTable({
  components,
  selectedComponents,
  onSelectionChange,
  onConfigure,
  configurationIssues,
  draftChangedComponents,
  isLoading,
}: {
  components: ComponentInfo[];
  selectedComponents: ComponentId[];
  onSelectionChange: (components: ComponentId[]) => void;
  onConfigure?: (target: EvaluationConfigurationTarget) => void;
  configurationIssues?: Partial<
    Record<ComponentId, EvaluationConfigurationIssue>
  >;
  draftChangedComponents?: ComponentId[];
  isLoading: boolean;
}) {
  const runnableIds = useMemo(
    () =>
      components
        .filter((component) => component.status === "active")
        .map((component) => component.id),
    [components],
  );
  const selectableIds = useMemo(() => runnableIds, [runnableIds]);
  const rowSelection = useMemo<RowSelectionState>(
    () =>
      Object.fromEntries(
        selectedComponents.map((component) => [component, true]),
      ),
    [selectedComponents],
  );
  const selectedSet = useMemo(
    () => new Set(selectedComponents),
    [selectedComponents],
  );
  const allRunnableSelected =
    runnableIds.length > 0 &&
    runnableIds.every((component) => selectedSet.has(component));
  const someRunnableSelected = runnableIds.some((component) =>
    selectedSet.has(component),
  );

  const toggleComponent = useCallback(
    (component: ComponentId, checked: boolean) => {
      onSelectionChange(
        checked
          ? [...new Set([...selectedComponents, component])]
          : selectedComponents.filter((candidate) => candidate !== component),
      );
    },
    [onSelectionChange, selectedComponents],
  );

  const columns = useMemo<ColumnDef<ComponentInfo>[]>(
    () => [
      {
        id: "select",
        size: 44,
        header: () => (
          <Checkbox
            checked={
              allRunnableSelected || (someRunnableSelected && "indeterminate")
            }
            disabled={runnableIds.length === 0}
            onCheckedChange={() =>
              onSelectionChange(allRunnableSelected ? [] : runnableIds)
            }
            aria-label="Select all runnable checks"
          />
        ),
        cell: ({ row }) => {
          const component = row.original;
          const selectable = component.status === "active";
          return (
            <Checkbox
              checked={selectable && selectedSet.has(component.id)}
              disabled={!selectable}
              onCheckedChange={(value) =>
                toggleComponent(component.id, value === true)
              }
              aria-label={`Select ${component.label}`}
            />
          );
        },
      },
      {
        id: "check",
        header: "Check",
        size: 440,
        cell: ({ row }) => {
          const component = row.original;
          const runnable = component.status === "active";
          return (
            <div className="min-w-0">
              <p
                className={cn(
                  "text-sm font-medium",
                  !runnable && "text-muted-foreground",
                )}
              >
                {component.label}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {component.description}
              </p>
            </div>
          );
        },
      },
      {
        id: "details",
        header: "Details",
        size: 420,
        cell: ({ row }) => {
          const component = row.original;
          return (
            <EvaluationCheckDetails
              component={component}
              components={components}
              selected={selectedSet.has(component.id)}
              onConfigure={onConfigure}
              configurationIssue={configurationIssues?.[component.id]}
              changedForDraft={draftChangedComponents?.includes(component.id)}
            />
          );
        },
      },
    ],
    [
      allRunnableSelected,
      components,
      configurationIssues,
      draftChangedComponents,
      onConfigure,
      onSelectionChange,
      runnableIds,
      selectedSet,
      someRunnableSelected,
      toggleComponent,
    ],
  );

  const handleRowSelectionChange = useCallback(
    (selection: RowSelectionState) => {
      onSelectionChange(
        Object.keys(selection).filter((component) =>
          selectableIds.includes(component as ComponentId),
        ) as ComponentId[],
      );
    },
    [onSelectionChange, selectableIds],
  );

  return (
    <DataTable
      columns={columns}
      data={components}
      rowSelection={rowSelection}
      onRowSelectionChange={handleRowSelectionChange}
      getRowId={(component) => component.id}
      hideSelectedCount
      hidePaginationWhenSinglePage
      compactPagination
      isLoading={isLoading}
      emptyMessage="No evaluation checks are available."
      tableClassName="min-w-[620px]"
      scrollRegionLabel="Evaluation checks table"
    />
  );
}

type EvaluationSetupLink =
  | {
      kind: "configuration";
      target: EvaluationConfigurationTarget;
    }
  | {
      kind: "deployment";
      label: string;
      href: string;
    };

function EvaluationCheckDetails({
  component,
  components,
  selected,
  onConfigure,
  configurationIssue,
  changedForDraft = false,
}: {
  component: ComponentInfo;
  components: ComponentInfo[];
  selected: boolean;
  onConfigure?: (target: EvaluationConfigurationTarget) => void;
  configurationIssue?: EvaluationConfigurationIssue;
  changedForDraft?: boolean;
}) {
  if (component.status === "active" && !configurationIssue) {
    return (
      <p className="text-xs leading-snug text-muted-foreground">
        {componentSelectionAndBillingExplanation(
          component,
          selected,
          changedForDraft,
        )}
      </p>
    );
  }

  const setupLinks =
    component.status === "active"
      ? []
      : evaluationSetupLinks(component, components);
  for (const target of configurationIssue?.targets ?? []) {
    if (
      !setupLinks.some(
        (link) => link.kind === "configuration" && link.target === target,
      )
    ) {
      setupLinks.unshift({ kind: "configuration", target });
    }
  }
  return (
    <div className="space-y-1.5 text-xs leading-snug text-foreground">
      <p>{configurationIssue?.detail ?? component.detail}</p>
      {setupLinks.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {setupLinks.map((link) => {
            if (link.kind === "deployment") {
              return (
                <ExternalDocsLink
                  key={link.label}
                  href={link.href}
                  className="text-xs"
                >
                  {link.label}
                </ExternalDocsLink>
              );
            }
            const target = EVALUATION_CONFIGURATION_TARGETS[link.target];
            return onConfigure ? (
              <button
                key={link.target}
                type="button"
                className="text-primary underline-offset-2 hover:underline"
                onClick={() => onConfigure(link.target)}
              >
                {target.label}
              </button>
            ) : (
              <a
                key={link.target}
                href={target.href}
                className="text-primary underline-offset-2 hover:underline"
              >
                {target.label}
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

function evaluationSetupLinks(
  component: ComponentInfo,
  components: ComponentInfo[],
): EvaluationSetupLink[] {
  if (
    component.id === "ocr" &&
    component.detail.startsWith("The evaluator OCR fixture")
  ) {
    return [];
  }
  const active = new Set(
    components
      .filter((candidate) => candidate.status === "active")
      .map((candidate) => candidate.id),
  );
  const links: EvaluationSetupLink[] = [];
  const addConfiguration = (target: EvaluationConfigurationTarget) => {
    if (
      !links.some(
        (link) => link.kind === "configuration" && link.target === target,
      )
    ) {
      links.push({ kind: "configuration", target });
    }
  };
  const addDeployment = (
    label: string,
    anchor: "hybrid-search" | "contextual-retrieval" | "context-expansion",
  ) => {
    links.push({
      kind: "deployment",
      label,
      href: getDocsUrl(DocsPage.PlatformKnowledge, anchor),
    });
  };

  switch (component.id) {
    case "text-embedding":
    case "image-embedding":
      addConfiguration("embedding");
      break;
    case "keyword-ranking":
      addDeployment("Hybrid search deployment setting", "hybrid-search");
      break;
    case "hybrid-retrieval":
      if (!active.has("text-embedding")) addConfiguration("embedding");
      if (!active.has("keyword-ranking")) {
        addDeployment("Hybrid search deployment setting", "hybrid-search");
      }
      break;
    case "reranking":
      if (!active.has("text-embedding")) addConfiguration("embedding");
      addConfiguration("reranking");
      break;
    case "query-expansion":
      if (!active.has("text-embedding")) addConfiguration("embedding");
      addConfiguration("reranking");
      break;
    case "contextual-retrieval":
      if (!active.has("text-embedding")) addConfiguration("embedding");
      if (!active.has("query-expansion")) addConfiguration("reranking");
      addDeployment(
        "Contextual retrieval deployment setting",
        "contextual-retrieval",
      );
      break;
    case "context-expansion":
      addDeployment(
        "Context expansion deployment setting",
        "context-expansion",
      );
      break;
    case "ocr":
      if (!active.has("text-embedding")) addConfiguration("embedding");
      addConfiguration("ocr");
      break;
  }
  return links;
}

function StartEvaluationWizard({
  open,
  onOpenChange,
  components,
  scenarios,
  initialSelectedComponents,
  pending,
  initialBm25K1,
  initialBm25B,
  initialEmbedding,
  initialReranker,
  initialOcr,
  initialContextualRetrievalMode,
  onAddApiKey,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  components: ComponentInfo[];
  scenarios: Capabilities["scenarios"];
  initialSelectedComponents: ComponentId[];
  pending: boolean;
  initialBm25K1: number;
  initialBm25B: number;
  initialEmbedding: EvaluationModelPair;
  initialReranker: EvaluationModelPair;
  initialOcr: EvaluationModelPair;
  initialContextualRetrievalMode: ContextualRetrievalMode;
  onAddApiKey: (purpose: "embedding" | "reranking" | "ocr") => void;
  onConfirm: (params: {
    components: ComponentId[];
    settingsOverrides: EvaluationSettingsOverrides;
  }) => void;
}) {
  const testEmbeddingConnection = useTestEmbeddingConnection();
  const testRerankerConnection = useTestRerankerConnection();
  const testOcrConnection = useTestOcrConnection();
  const [step, setStep] = useState<StartWizardStep>("configuration");
  const [selectedComponents, setSelectedComponents] = useState<ComponentId[]>(
    initialSelectedComponents,
  );
  const [bm25K1, setBm25K1] = useState(String(initialBm25K1));
  const [bm25B, setBm25B] = useState(String(initialBm25B));
  const [embedding, setEmbedding] = useState(initialEmbedding);
  const [reranker, setReranker] = useState(initialReranker);
  const [ocr, setOcr] = useState(initialOcr);
  const [contextualRetrievalMode, setContextualRetrievalMode] = useState(
    initialContextualRetrievalMode,
  );
  const [configurationFocusTarget, setConfigurationFocusTarget] =
    useState<EvaluationConfigurationTarget | null>(null);
  const [embeddingStatus, setEmbeddingStatus] = useState<SectionStatus>({
    status: "untested",
    error: null,
  });
  const [rerankerStatus, setRerankerStatus] = useState<SectionStatus>({
    status: "untested",
    error: null,
  });
  const [ocrStatus, setOcrStatus] = useState<SectionStatus>({
    status: "untested",
    error: null,
  });
  const [validatingConfiguration, setValidatingConfiguration] = useState(false);
  const [configurationValidationError, setConfigurationValidationError] =
    useState<string | null>(null);
  const wasOpen = useRef(false);
  const autoSelectedPreviewSignature = useRef<string | null>(null);
  const hasAutoSelectedPreview = useRef(false);
  const autoTestSignatures = useRef({
    embedding: "",
    reranker: "",
    ocr: "",
  });
  useEffect(() => {
    const opening = open && !wasOpen.current;
    wasOpen.current = open;
    if (!opening) return;
    setStep("configuration");
    setSelectedComponents(initialSelectedComponents);
    setBm25K1(String(initialBm25K1));
    setBm25B(String(initialBm25B));
    setEmbedding(initialEmbedding);
    setReranker(initialReranker);
    setOcr(initialOcr);
    setContextualRetrievalMode(initialContextualRetrievalMode);
    setConfigurationFocusTarget(null);
    setEmbeddingStatus({ status: "untested", error: null });
    setRerankerStatus({ status: "untested", error: null });
    setOcrStatus({ status: "untested", error: null });
    setValidatingConfiguration(false);
    setConfigurationValidationError(null);
    autoSelectedPreviewSignature.current = null;
    hasAutoSelectedPreview.current = false;
    autoTestSignatures.current = {
      embedding: modelPairSignature(initialEmbedding),
      reranker: modelPairSignature(initialReranker),
      ocr: modelPairSignature(initialOcr),
    };
  }, [
    open,
    initialSelectedComponents,
    initialBm25K1,
    initialBm25B,
    initialEmbedding,
    initialReranker,
    initialOcr,
    initialContextualRetrievalMode,
  ]);
  useEffect(() => {
    if (step !== "configuration" || !configurationFocusTarget) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(
        EVALUATION_CONFIGURATION_TARGETS[configurationFocusTarget].wizardId,
      );
      target?.scrollIntoView({ block: "start", behavior: "smooth" });
      target?.focus();
      setConfigurationFocusTarget(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [configurationFocusTarget, step]);

  const requirements = evaluationSettingsRequirements(selectedComponents);
  const bm25Valid = validBm25Overrides({ bm25K1, bm25B });
  const selectedConfigurationValid =
    (!requirements.bm25 || bm25Valid) &&
    (!requirements.embedding || completeModelPair(embedding)) &&
    (!requirements.reranker || completeModelPair(reranker)) &&
    (!requirements.ocr || completeModelPair(ocr)) &&
    (!requirements.contextualRetrieval ||
      contextualRetrievalMode !== "disabled");
  const missingSettings = [
    requirements.bm25 && !bm25Valid ? "valid keyword-ranking values" : null,
    requirements.embedding && !completeModelPair(embedding)
      ? "embedding key and model"
      : null,
    requirements.reranker && !completeModelPair(reranker)
      ? "reranking key and model"
      : null,
    requirements.ocr && !completeModelPair(ocr) ? "OCR key and model" : null,
    requirements.contextualRetrieval && contextualRetrievalMode === "disabled"
      ? "context generation"
      : null,
  ].filter((value): value is string => value !== null);
  const stepIndex = START_WIZARD_STEPS.findIndex(
    (candidate) => candidate.id === step,
  );
  const previousStep = START_WIZARD_STEPS[stepIndex - 1];
  const nextStep = START_WIZARD_STEPS[stepIndex + 1];
  const settingsOverrides: EvaluationSettingsOverrides = {
    ...(bm25Valid ? { bm25K1: Number(bm25K1), bm25B: Number(bm25B) } : {}),
    ...(completeModelPair(embedding) ? { embedding } : {}),
    ...(completeModelPair(reranker) ? { reranker } : {}),
    ...(completeModelPair(ocr) ? { ocr } : {}),
    contextualRetrievalMode,
  };
  const capabilitiesPreview = useRetrievalEvaluationCapabilitiesPreview({
    settingsOverrides,
    enabled: open && step !== "configuration",
  });
  const effectiveComponents =
    capabilitiesPreview.data?.components ?? components;
  const effectiveScenarios = capabilitiesPreview.data?.scenarios ?? scenarios;
  const configurationIssues = evaluationDraftConfigurationIssues({
    components: effectiveComponents,
    bm25Valid,
    embedding,
    reranker,
    ocr,
    contextualRetrievalMode,
  });
  const draftChangedComponents = useMemo(
    () =>
      evaluationDraftChangedComponents({
        components: effectiveComponents,
        bm25Changed:
          bm25Valid &&
          (Number(bm25K1) !== initialBm25K1 || Number(bm25B) !== initialBm25B),
        embeddingChanged: modelPairChanged(embedding, initialEmbedding),
        rerankerChanged: modelPairChanged(reranker, initialReranker),
        ocrChanged: modelPairChanged(ocr, initialOcr),
        contextualRetrievalChanged:
          contextualRetrievalMode !== initialContextualRetrievalMode,
      }),
    [
      bm25B,
      bm25K1,
      bm25Valid,
      contextualRetrievalMode,
      effectiveComponents,
      embedding,
      initialBm25B,
      initialBm25K1,
      initialContextualRetrievalMode,
      initialEmbedding,
      initialOcr,
      initialReranker,
      ocr,
      reranker,
    ],
  );
  const recommendedForDraft = useMemo(
    () => [
      ...new Set([
        ...effectiveComponents
          .filter(
            (component) =>
              component.status === "active" && component.selectedByDefault,
          )
          .map((component) => component.id),
        ...draftChangedComponents,
      ]),
    ],
    [draftChangedComponents, effectiveComponents],
  );
  const previewSettingsSignature = JSON.stringify(settingsOverrides);
  useEffect(() => {
    if (
      step !== "checks" ||
      !capabilitiesPreview.data ||
      autoSelectedPreviewSignature.current === previewSettingsSignature
    ) {
      return;
    }
    autoSelectedPreviewSignature.current = previewSettingsSignature;
    const automaticSelections = hasAutoSelectedPreview.current
      ? draftChangedComponents
      : recommendedForDraft;
    hasAutoSelectedPreview.current = true;
    setSelectedComponents((current) => {
      const selected = new Set([...current, ...automaticSelections]);
      return effectiveComponents
        .filter(
          (component) =>
            component.status === "active" && selected.has(component.id),
        )
        .map((component) => component.id);
    });
  }, [
    capabilitiesPreview.data,
    draftChangedComponents,
    effectiveComponents,
    previewSettingsSignature,
    recommendedForDraft,
    step,
  ]);
  const selectedInfo = effectiveComponents.filter((component) =>
    selectedComponents.includes(component.id),
  );
  const selectedScenarios = effectiveScenarios.filter((scenario) =>
    selectedComponents.includes(scenario.component),
  );
  const skippedCrossEncoderScenario = selectedScenarios.find(
    (scenario) =>
      scenario.id === "cross-encoder-procedure" && !scenario.applicable,
  );
  const online = selectedInfo.filter(
    (component) => component.mode === "online",
  );
  const selectedCapabilitiesValid = selectedComponents.every(
    (componentId) =>
      effectiveComponents.find((component) => component.id === componentId)
        ?.status === "active",
  );
  const canContinue =
    step === "configuration" ||
    (!capabilitiesPreview.isPending &&
      !capabilitiesPreview.isError &&
      selectedComponents.length > 0 &&
      selectedConfigurationValid &&
      selectedCapabilitiesValid);
  const runEmbeddingTest = useCallback(async (): Promise<boolean> => {
    if (!completeModelPair(embedding)) {
      setEmbeddingStatus({ status: "untested", error: null });
      return true;
    }
    setEmbeddingStatus({ status: "testing", error: null });
    try {
      const result = await testEmbeddingConnection.mutateAsync({
        embeddingChatApiKeyId: embedding.chatApiKeyId,
        embeddingModel: embedding.model,
      });
      if (!result.success) {
        const error = result.error ?? "Connection failed.";
        setEmbeddingStatus({ status: "failed", error });
        setConfigurationValidationError(error);
        return false;
      }
      setEmbeddingStatus({ status: "connected", error: null });
      return true;
    } catch {
      setEmbeddingStatus({
        status: "failed",
        error: "Connection test failed.",
      });
      setConfigurationValidationError("Connection test failed.");
      return false;
    }
  }, [embedding, testEmbeddingConnection]);

  const runRerankerTest = useCallback(async (): Promise<boolean> => {
    if (!completeModelPair(reranker)) {
      setRerankerStatus({ status: "untested", error: null });
      return true;
    }
    setRerankerStatus({ status: "testing", error: null });
    try {
      const result = await testRerankerConnection.mutateAsync({
        rerankerChatApiKeyId: reranker.chatApiKeyId,
        rerankerModel: reranker.model,
      });
      if (!result.success) {
        const error = result.error ?? "Connection failed.";
        setRerankerStatus({ status: "failed", error });
        setConfigurationValidationError(error);
        return false;
      }
      setRerankerStatus({ status: "connected", error: null });
      return true;
    } catch {
      setRerankerStatus({ status: "failed", error: "Connection test failed." });
      setConfigurationValidationError("Connection test failed.");
      return false;
    }
  }, [reranker, testRerankerConnection]);

  const runOcrTest = useCallback(async (): Promise<boolean> => {
    if (!completeModelPair(ocr)) {
      setOcrStatus({ status: "untested", error: null });
      return true;
    }
    setOcrStatus({ status: "testing", error: null });
    try {
      const result = await testOcrConnection.mutateAsync({
        ocrChatApiKeyId: ocr.chatApiKeyId,
        ocrModel: ocr.model,
      });
      if (!result.success) {
        const error = result.error ?? "Connection failed.";
        setOcrStatus({ status: "failed", error });
        setConfigurationValidationError(error);
        return false;
      }
      setOcrStatus({ status: "connected", error: null });
      return true;
    } catch {
      setOcrStatus({ status: "failed", error: "Connection test failed." });
      setConfigurationValidationError("Connection test failed.");
      return false;
    }
  }, [ocr, testOcrConnection]);

  useEffect(() => {
    if (!open) return;
    const signature = modelPairSignature(embedding);
    if (autoTestSignatures.current.embedding === signature) return;
    autoTestSignatures.current.embedding = signature;
    void runEmbeddingTest();
  }, [embedding, open, runEmbeddingTest]);

  useEffect(() => {
    if (!open) return;
    const signature = modelPairSignature(reranker);
    if (autoTestSignatures.current.reranker === signature) return;
    autoTestSignatures.current.reranker = signature;
    void runRerankerTest();
  }, [open, reranker, runRerankerTest]);

  useEffect(() => {
    if (!open) return;
    const signature = modelPairSignature(ocr);
    if (autoTestSignatures.current.ocr === signature) return;
    autoTestSignatures.current.ocr = signature;
    void runOcrTest();
  }, [ocr, open, runOcrTest]);

  const validateConfiguration = async (): Promise<boolean> => {
    setValidatingConfiguration(true);
    setConfigurationValidationError(null);
    try {
      const connectionResults = await Promise.all([
        runEmbeddingTest(),
        runRerankerTest(),
        runOcrTest(),
      ]);
      if (connectionResults.some((connected) => !connected)) return false;

      const preview = await capabilitiesPreview.refetch();
      const previewComponents =
        preview?.data?.components ?? capabilitiesPreview.data?.components ?? [];
      const unavailableOcr = completeModelPair(ocr)
        ? previewComponents.find(
            (component) =>
              component.id === "ocr" && component.status !== "active",
          )
        : null;
      if (unavailableOcr) {
        setOcrStatus({ status: "failed", error: unavailableOcr.detail });
        setConfigurationValidationError(unavailableOcr.detail);
        return false;
      }
      return !(preview?.isError ?? capabilitiesPreview.isError);
    } catch {
      setConfigurationValidationError("Connection test failed.");
      return false;
    } finally {
      setValidatingConfiguration(false);
    }
  };

  const navigateToStep = async (target: StartWizardStep): Promise<void> => {
    if (target === step || validatingConfiguration) return;
    if (step === "configuration") {
      if (target !== "checks" || !(await validateConfiguration())) return;
      setSelectedComponents((current) => [
        ...new Set([...current, ...draftChangedComponents]),
      ]);
    }
    setStep(target);
  };

  return (
    <StandardDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Start retrieval evaluation"
      description={START_WIZARD_STEP_DESCRIPTIONS[step]}
      size="large"
      bodyClassName="space-y-6"
      footer={
        <div className="flex flex-1 items-center justify-between gap-4">
          <div>
            {previousStep ? (
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => setStep(previousStep.id)}
              >
                <ArrowLeft className="size-4" />
                <span>{previousStep.title}</span>
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
            )}
          </div>
          {nextStep ? (
            <Button
              type="button"
              disabled={!canContinue || validatingConfiguration}
              onClick={() => void navigateToStep(nextStep.id)}
            >
              {validatingConfiguration && (
                <Loader2 className="size-4 animate-spin" />
              )}
              <span>
                {validatingConfiguration
                  ? "Testing connections"
                  : nextStep.title}
              </span>
              <ArrowRight className="size-4" />
            </Button>
          ) : (
            <Button
              type="button"
              disabled={pending || !canContinue}
              onClick={() =>
                onConfirm({
                  components: selectedComponents,
                  settingsOverrides,
                })
              }
            >
              {pending && <Loader2 className="size-4 animate-spin" />}
              <span>Start evaluation</span>
            </Button>
          )}
        </div>
      }
    >
      <WizardStepper
        steps={START_WIZARD_STEPS}
        activeStep={step}
        onStepClick={(target) => {
          const targetIndex = START_WIZARD_STEPS.findIndex(
            (candidate) => candidate.id === target,
          );
          if (
            targetIndex < stepIndex ||
            (step === "configuration" && target === "checks")
          ) {
            void navigateToStep(target);
          }
        }}
        stepTestIdPrefix="retrieval-evaluation-step"
      />

      {step === "configuration" && (
        <section className="space-y-5">
          {configurationValidationError && (
            <Alert variant="destructive">
              <CircleX />
              <AlertTitle>Configuration test failed</AlertTitle>
              <AlertDescription>
                {configurationValidationError}
              </AlertDescription>
            </Alert>
          )}
          <KnowledgeConfigurationFields
            embedding={embedding}
            onEmbeddingChange={setEmbedding}
            reranker={reranker}
            onRerankerChange={setReranker}
            ocr={ocr}
            onOcrChange={setOcr}
            onAddApiKey={onAddApiKey}
            required={{
              embedding: requirements.embedding,
              reranker: requirements.reranker,
              ocr: requirements.ocr,
            }}
            bm25K1={bm25K1}
            bm25B={bm25B}
            onBm25K1Change={setBm25K1}
            onBm25BChange={setBm25B}
            onBm25K1Blur={() => {
              if (bm25K1.trim() === "") setBm25K1(String(initialBm25K1));
            }}
            onBm25BBlur={() => {
              if (bm25B.trim() === "") setBm25B(String(initialBm25B));
            }}
            contextualRetrievalMode={contextualRetrievalMode}
            onContextualRetrievalModeChange={setContextualRetrievalMode}
            showDescriptions={false}
            idPrefix="evaluation-"
            embeddingAfterFields={
              <KnowledgeConnectionActions
                configured={completeModelPair(embedding)}
                status={embeddingStatus.status}
                onTest={() => void runEmbeddingTest()}
                clearLabel="Clear embedding configuration"
                onClear={() =>
                  setEmbedding({ chatApiKeyId: null, model: null })
                }
              />
            }
            rerankerAfterFields={
              <KnowledgeConnectionActions
                configured={completeModelPair(reranker)}
                status={rerankerStatus.status}
                onTest={() => void runRerankerTest()}
                clearLabel="Clear reranking configuration"
                onClear={() => setReranker({ chatApiKeyId: null, model: null })}
              />
            }
            ocrAfterFields={
              <KnowledgeConnectionActions
                configured={completeModelPair(ocr)}
                status={ocrStatus.status}
                onTest={() => void runOcrTest()}
                clearLabel="Clear OCR configuration"
                onClear={() => setOcr({ chatApiKeyId: null, model: null })}
              />
            }
          />
        </section>
      )}

      {step === "checks" && (
        <section className="space-y-4">
          {capabilitiesPreview.isError && (
            <Alert variant="destructive">
              <CircleX />
              <AlertTitle>Could not validate these settings</AlertTitle>
              <AlertDescription>
                Check the selected keys and models, then try again.
              </AlertDescription>
            </Alert>
          )}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              {selectedChecksLabel(selectedComponents.length)}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={recommendedForDraft.length === 0}
              onClick={() => setSelectedComponents(recommendedForDraft)}
            >
              Select new and changed
            </Button>
          </div>
          <Alert>
            <Info />
            <AlertTitle>New and changed checks are selected</AlertTitle>
            <AlertDescription>
              Checks already tested with the same effective configuration stay
              clear because a different result is not expected. You can still
              select any available check manually.
            </AlertDescription>
          </Alert>

          <EvaluationChecksTable
            components={effectiveComponents}
            selectedComponents={selectedComponents}
            onSelectionChange={setSelectedComponents}
            configurationIssues={configurationIssues}
            draftChangedComponents={draftChangedComponents}
            onConfigure={(target) => {
              setConfigurationFocusTarget(target);
              setStep("configuration");
            }}
            isLoading={capabilitiesPreview.isPending}
          />

          {skippedCrossEncoderScenario && (
            <Alert variant="warning">
              <AlertTriangle />
              <AlertTitle>
                Native cross-encoder will not be evaluated
              </AlertTitle>
              <AlertDescription>
                The selected reranker is an LLM, not a native cross-encoder. The
                run will skip the cross-encoder procedure. Choose a model and
                provider served through a supported native rerank API to include
                it.
              </AlertDescription>
            </Alert>
          )}
          {selectedComponents.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {testCaseCountLabel(selectedScenarios.length)}
            </p>
          )}
          {online.length > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
              <p>
                This run makes LLM API provider calls for {online.length}{" "}
                {online.length === 1 ? "check" : "checks"}. Provider charges may
                apply.
              </p>
            </div>
          )}
          {selectedComponents.length > 0 && online.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Offline checks make no provider calls.
            </p>
          )}

          {selectedComponents.length === 0 && (
            <p className="text-sm text-destructive">
              Select at least one check to continue.
            </p>
          )}
          {selectedComponents.length > 0 && missingSettings.length > 0 && (
            <Alert variant="warning">
              <AlertTriangle />
              <AlertTitle>Configuration required</AlertTitle>
              <AlertDescription>
                Go back and configure {formatList(missingSettings)} for the
                selected checks.
              </AlertDescription>
            </Alert>
          )}
        </section>
      )}
    </StandardDialog>
  );
}

function ProviderModelValue({
  provider,
  model,
  providerLabel,
}: {
  provider: string | null | undefined;
  model: string;
  providerLabel: (provider: SupportedProvider) => string;
}) {
  if (!isSupportedProvider(provider)) return <span>{model}</span>;

  return (
    <span className="flex min-w-0 items-center gap-2">
      <ProviderIcon provider={provider} />
      <span>{providerLabel(provider)}</span>
      <span className="text-muted-foreground">·</span>
      <span className="truncate">{model}</span>
    </span>
  );
}

function RunDetailsDialog({
  runId,
  onClose,
  onCancel,
  cancelling,
}: {
  runId: string | null;
  onClose: () => void;
  onCancel: (id: string) => void;
  cancelling: boolean;
}) {
  const query = useRetrievalEvaluationRun(runId);
  const capabilities = useRetrievalEvaluationCapabilities();
  const run = query.data;
  const artifact = run?.artifact;
  const componentById = new Map(
    capabilities.data?.components.map((component) => [
      component.id,
      component,
    ]) ?? [],
  );
  const runComponents =
    run?.selectedComponents.length && run.selectedComponents.length > 0
      ? run.selectedComponents
      : (artifact?.selection?.components ?? []);
  const componentResults = artifact?.selection?.componentResults ?? [];
  const artifactWarnings = [...new Set(artifact?.warnings ?? [])];
  const skippedCrossEncoder = artifact?.skippedQueries.find(
    (query) => query.id === "cross-encoder-procedure",
  );
  const active = run ? isActive(run.status) : false;
  const cancellingRequested = run?.status === "cancel_requested";

  return (
    <Dialog
      open={runId !== null}
      onOpenChange={(open) => {
        if (open) return;
        onClose();
      }}
    >
      <DialogContent className="max-w-4xl" showCloseButton={!active}>
        <DialogHeader>
          <DialogTitle>
            {run
              ? runDialogTitle(run.status)
              : "Knowledge configuration evaluation"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Knowledge configuration evaluation status and results.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {query.isError ? (
            <Alert variant="destructive">
              <CircleX />
              <AlertTitle>Could not load this evaluation</AlertTitle>
              <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                <p>Check your connection, then try again.</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void query.refetch()}
                >
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          ) : !run ? (
            <p className="text-sm text-muted-foreground">
              {query.isLoading ? "Loading evaluation..." : "Run not found."}
            </p>
          ) : (
            <div className="space-y-4">
              {active && (
                <div className="space-y-4">
                  <output className="block" aria-live="polite">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="flex items-center gap-2 font-medium">
                        {(run.status === "queued" || cancellingRequested) && (
                          <Loader2 className="size-4 animate-spin text-primary" />
                        )}
                        {run.status === "queued"
                          ? "Waiting to start"
                          : cancellingRequested
                            ? "Stopping evaluation"
                            : (run.progressMessage ?? "Evaluation running")}
                      </span>
                      {run.status === "running" && (
                        <span className="tabular-nums text-muted-foreground">
                          {progressPercent(run)}% complete
                        </span>
                      )}
                    </div>
                    {run.status === "running" ? (
                      <Progress
                        value={progressPercent(run)}
                        aria-label="Evaluation progress"
                        className="mt-2 h-1.5"
                      />
                    ) : (
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-primary/20">
                        <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
                      </div>
                    )}
                    {cancellingRequested && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        The evaluation stops after the current provider request
                        finishes.
                      </p>
                    )}
                  </output>

                  <div className="flex gap-3 rounded-md border border-blue-500/30 bg-blue-500/5 p-3">
                    <Info className="mt-0.5 size-4 shrink-0 text-blue-600 dark:text-blue-400" />
                    <div>
                      <p className="text-sm font-medium">
                        This evaluation runs in the background
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        You can leave this dialog or page. Progress and results
                        will remain available here.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {run.error && (
                <Alert variant="destructive">
                  <CircleX />
                  <AlertTitle>Evaluation failed</AlertTitle>
                  <AlertDescription>
                    <p>{run.error}</p>
                  </AlertDescription>
                </Alert>
              )}

              {artifact && (
                <>
                  {Object.keys(run.settingsOverrides ?? {}).length > 0 && (
                    <RunSettingsOverrides
                      settings={run.settingsOverrides ?? {}}
                      fingerprint={artifact.fingerprint}
                    />
                  )}
                  {artifactWarnings.length > 0 && (
                    <Alert variant="warning">
                      <AlertTriangle />
                      <AlertTitle>Completed with issues</AlertTitle>
                      <AlertDescription>
                        <ul className="list-disc space-y-1 pl-4">
                          {artifactWarnings.map((warning) => (
                            <li key={warning}>{warning}</li>
                          ))}
                        </ul>
                      </AlertDescription>
                    </Alert>
                  )}
                  {skippedCrossEncoder && (
                    <Alert variant="warning">
                      <AlertTriangle />
                      <AlertTitle>
                        Native cross-encoder was not evaluated
                      </AlertTitle>
                      <AlertDescription>
                        <p>
                          The configured reranker did not run the native
                          cross-encoder procedure.
                        </p>
                        {skippedCrossEncoder.reasons.length > 0 && (
                          <ul className="mt-1 list-disc space-y-1 pl-4">
                            {skippedCrossEncoder.reasons.map((reason) => (
                              <li key={reason}>{reason}</li>
                            ))}
                          </ul>
                        )}
                      </AlertDescription>
                    </Alert>
                  )}
                  {artifact.queries.length > 0 && (
                    <section>
                      <h3 className="mb-3 text-base font-semibold">Results</h3>
                      <div className="overflow-hidden rounded-md border">
                        <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3 bg-muted/30 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                          <span>Metric</span>
                          <span>Value</span>
                        </div>
                        <div className="divide-y">
                          <RunMetricRow
                            label="Hit@5"
                            value={formatPercent(artifact.aggregates["hit@5"])}
                            help="Hit@5 is the percentage of test cases with an expected source among the first five results."
                            docsUrl={HIT_AT_5_DOCS_URL}
                          />
                          <RunMetricRow
                            label="MRR"
                            value={formatPercent(artifact.aggregates.mrr)}
                            help="MRR uses the rank of the first expected source. Rank 1 is 100%, rank 2 is 50%, rank 3 is 33%, and not returned is 0%."
                            docsUrl={MRR_DOCS_URL}
                          />
                          <RunMetricRow
                            label="Precision@5"
                            value={formatPercent(
                              artifact.aggregates["precision@5"],
                            )}
                            help="Percentage of the first five result positions occupied by relevant documents."
                            docsUrl={EVALUATION_METRICS_DOCS_URL}
                          />
                          {artifact.aggregates["ndcg@5"] !== undefined && (
                            <RunMetricRow
                              label="nDCG@5"
                              value={formatPercent(
                                artifact.aggregates["ndcg@5"],
                              )}
                              help="Rewards highly relevant documents appearing near the top of the first five results."
                              docsUrl={EVALUATION_METRICS_DOCS_URL}
                            />
                          )}
                          {artifact.aggregates["map@5"] !== undefined && (
                            <RunMetricRow
                              label="MAP@5"
                              value={formatPercent(
                                artifact.aggregates["map@5"],
                              )}
                              help="Average precision across answerable test cases within the first five results."
                              docsUrl={EVALUATION_METRICS_DOCS_URL}
                            />
                          )}
                          {artifact.aggregates["negativeHitRate@5"] !==
                            undefined && (
                            <RunMetricRow
                              label="Negative hit rate@5"
                              value={formatPercent(
                                artifact.aggregates["negativeHitRate@5"],
                              )}
                              help="Percentage of judged test cases where a forbidden result appeared in the first five positions. Lower is better."
                              docsUrl={EVALUATION_METRICS_DOCS_URL}
                            />
                          )}
                          {artifact.aggregates.noAnswerForcedRetrievalRate !==
                            undefined && (
                            <RunMetricRow
                              label="No-answer forced retrieval"
                              value={formatPercent(
                                artifact.aggregates.noAnswerForcedRetrievalRate,
                              )}
                              help="Percentage of no-answer controls where retrieval still returned a result. Lower is better. This remains diagnostic until the product supports abstention."
                              docsUrl={EVALUATION_METRICS_DOCS_URL}
                            />
                          )}
                        </div>
                      </div>
                    </section>
                  )}

                  {(artifact.uncertainty || artifact.bySegment) && (
                    <RunConfidenceDetails
                      uncertainty={artifact.uncertainty}
                      bySegment={artifact.bySegment}
                    />
                  )}

                  <RunCheckResults
                    runComponents={runComponents}
                    componentResults={componentResults}
                    componentById={componentById}
                  />

                  {(artifact.queries.length > 0 ||
                    artifact.skippedQueries.length > 0) && (
                    <section>
                      <h3 className="mb-3 text-base font-semibold">
                        Test case results
                      </h3>
                      <TestCaseResults
                        results={artifact.queries}
                        skipped={artifact.skippedQueries}
                      />
                    </section>
                  )}
                </>
              )}
            </div>
          )}
        </DialogBody>
        {run && (
          <DialogFooter>
            {(run.status === "queued" || run.status === "running") && (
              <WithPermissions
                permissions={{ knowledgeSettings: ["update"] }}
                noPermissionHandle="tooltip"
              >
                {({ hasPermission }) => (
                  <Button
                    type="button"
                    variant="outline"
                    className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    disabled={!hasPermission || cancelling}
                    onClick={() => onCancel(run.id)}
                  >
                    {cancelling ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Square className="size-3.5" />
                    )}
                    <span>Cancel evaluation</span>
                  </Button>
                )}
              </WithPermissions>
            )}
            {artifact && (
              <Button
                type="button"
                variant="outline"
                onClick={() => downloadArtifact(run)}
              >
                <Download className="size-3.5" />
                <span>Download results (JSON)</span>
              </Button>
            )}
            <DialogClose asChild>
              <Button type="button">
                {active ? "Continue in background" : "Done"}
              </Button>
            </DialogClose>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

type RunCheckResult = {
  component: ComponentId;
  label: string;
  mode?: "offline" | "online";
  status: "passed" | "failed" | "skipped";
  detail?: string;
};

function RunSettingsOverrides({
  settings,
  fingerprint,
}: {
  settings: EvaluationSettingsOverrides;
  fingerprint?: NonNullable<RunDetail["artifact"]>["fingerprint"];
}) {
  const providerCatalog = useModelProviderCatalog();
  const rows: Array<{ label: string; value: ReactNode }> = [];
  if (settings.embedding) {
    rows.push({
      label: "Embedding Model",
      value: (
        <ProviderModelValue
          provider={fingerprint?.embedding?.provider}
          model={settings.embedding.model}
          providerLabel={providerCatalog.label}
        />
      ),
    });
  }
  if (settings.reranker) {
    rows.push({
      label: "Reranking Model",
      value: (
        <ProviderModelValue
          provider={fingerprint?.reranker?.provider}
          model={settings.reranker.model}
          providerLabel={providerCatalog.label}
        />
      ),
    });
  }
  if (settings.ocr) {
    rows.push({
      label: "Document OCR Model",
      value: (
        <ProviderModelValue
          provider={fingerprint?.ocr?.provider}
          model={settings.ocr.model}
          providerLabel={providerCatalog.label}
        />
      ),
    });
  }
  if (settings.bm25K1 !== undefined) {
    rows.push({ label: "Term Saturation", value: settings.bm25K1 });
  }
  if (settings.bm25B !== undefined) {
    rows.push({ label: "Length Normalization", value: settings.bm25B });
  }
  return (
    <section>
      <h3 className="mb-3 text-base font-semibold">Test settings</h3>
      <div className="divide-y rounded-md border">
        {rows.map((row) => (
          <div
            key={row.label}
            className="grid gap-3 px-3 py-2.5 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(12rem,1fr)]"
          >
            <span>{row.label}</span>
            <span className="min-w-0 font-medium tabular-nums">
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function RunCheckResults({
  runComponents,
  componentResults,
  componentById,
}: {
  runComponents: ComponentId[];
  componentResults: NonNullable<
    NonNullable<RunDetail["artifact"]>["selection"]
  >["componentResults"];
  componentById: Map<ComponentId, ComponentInfo>;
}) {
  const results: RunCheckResult[] = runComponents.map((component) => {
    const result = componentResults.find(
      (candidate) => candidate.component === component,
    );
    return {
      component,
      label: componentById.get(component)?.label ?? componentLabel(component),
      mode: result?.mode,
      status: result?.status ?? "skipped",
      detail: result?.detail,
    };
  });
  return (
    <section>
      <h3 className="mb-3 text-base font-semibold">Check results</h3>
      <div className="space-y-2">
        <RunCheckResultGroup
          title="Failed"
          status="failed"
          results={results.filter((result) => result.status === "failed")}
          defaultOpen
        />
        <RunCheckResultGroup
          title="Passed"
          status="passed"
          results={results.filter((result) => result.status === "passed")}
        />
        <RunCheckResultGroup
          title="Skipped"
          status="skipped"
          results={results.filter((result) => result.status === "skipped")}
        />
      </div>
    </section>
  );
}

function RunCheckResultGroup({
  title,
  status,
  results,
  defaultOpen = false,
}: {
  title: string;
  status: RunCheckResult["status"];
  results: RunCheckResult[];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (results.length === 0) return null;
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="overflow-hidden rounded-md border"
    >
      <summary
        className={cn(
          "cursor-pointer bg-muted/20 px-3 py-2.5 text-sm font-medium",
          status === "failed" && "text-destructive",
          status === "passed" && "text-emerald-600",
        )}
      >
        {title} ({results.length})
      </summary>
      <div className="divide-y border-t">
        {results.map((result) => (
          <ComponentResultRow
            key={result.component}
            label={result.label}
            mode={result.mode}
            status={result.status}
            detail={result.detail}
          />
        ))}
      </div>
    </details>
  );
}

function ComponentResultRow({
  label,
  mode,
  status,
  detail,
}: {
  label: string;
  mode?: "offline" | "online";
  status?: "passed" | "failed" | "skipped";
  detail?: string;
}) {
  const Icon = status === "passed" ? Check : status === "failed" ? X : Minus;
  return (
    <div className="flex items-start gap-3 px-3 py-2.5">
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          status === "passed" && "text-emerald-600",
          status === "failed" && "text-destructive",
          (!status || status === "skipped") && "text-muted-foreground",
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {label}
          {mode === "offline" && (
            <span className="ml-2 font-normal text-muted-foreground">
              Offline
            </span>
          )}
        </p>
        {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
      </div>
    </div>
  );
}

function TestCaseResults({
  results,
  skipped,
}: {
  results: NonNullable<RunDetail["artifact"]>["queries"];
  skipped: NonNullable<RunDetail["artifact"]>["skippedQueries"];
}) {
  const gated = results.filter((result) => result.gateMode !== "metric-only");
  const failed = gated.filter((result) => !result.passed);
  const passed = gated.filter((result) => result.passed);
  const measuredOnly = results.filter(
    (result) => result.gateMode === "metric-only",
  );
  return (
    <div className="space-y-2">
      <TestCaseResultGroup title="Failed" results={failed} defaultOpen />
      <TestCaseResultGroup title="Passed" results={passed} />
      <TestCaseResultGroup title="Measured only" results={measuredOnly} />
      <SkippedTestCaseGroup skipped={skipped} />
    </div>
  );
}

type TestCaseResult = NonNullable<RunDetail["artifact"]>["queries"][number];

function TestCaseResultGroup({
  title,
  results,
  defaultOpen = false,
}: {
  title: string;
  results: TestCaseResult[];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (results.length === 0) return null;
  const failed = title === "Failed";
  const passed = title === "Passed";
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="overflow-hidden rounded-md border"
    >
      <summary
        className={cn(
          "cursor-pointer bg-muted/20 px-3 py-2.5 text-sm font-medium",
          failed && "text-destructive",
          passed && "text-emerald-600",
          !failed && !passed && "text-muted-foreground",
        )}
      >
        {title} ({results.length})
      </summary>
      <div className="overflow-x-auto border-t">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Query</TableHead>
              <TableHead>First expected result</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {results.map((result) => (
              <TableRow key={result.id}>
                <TableCell className="min-w-64">
                  <p className="text-sm">{result.query}</p>
                  {result.stageFailures.length > 0 && (
                    <p className="mt-1 text-xs text-destructive">
                      {result.stageFailures.join("; ")}
                    </p>
                  )}
                </TableCell>
                <TableCell>
                  {formatResultPosition(bestRank(result.firstRank))}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </details>
  );
}

function SkippedTestCaseGroup({
  skipped,
}: {
  skipped: NonNullable<RunDetail["artifact"]>["skippedQueries"];
}) {
  const [open, setOpen] = useState(false);
  if (skipped.length === 0) return null;
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="overflow-hidden rounded-md border"
    >
      <summary className="cursor-pointer bg-muted/20 px-3 py-2.5 text-sm font-medium text-muted-foreground">
        Skipped ({skipped.length})
      </summary>
      <div className="space-y-2 border-t px-3 py-2.5 text-xs text-muted-foreground">
        {skipped.map((item) => (
          <p key={item.id}>
            <span className="font-medium text-foreground">{item.id}:</span>{" "}
            {item.reasons.join("; ")}
          </p>
        ))}
      </div>
    </details>
  );
}

function ComparisonDialog({
  ids,
  onClose,
}: {
  ids: { beforeId: string; afterId: string } | null;
  onClose: () => void;
}) {
  const comparison = useRetrievalEvaluationComparison({
    beforeId: ids?.beforeId ?? null,
    afterId: ids?.afterId ?? null,
  });
  const data = comparison.data;
  const changedComponents =
    data?.componentResults.filter((result) => result.changed) ?? [];
  const queryGroups = groupComparisonQueries(data?.queries ?? []);
  const regressedChecks = changedComponents.filter(
    (result) => componentOutcomeDirection(result) === "regressed",
  ).length;
  const improvedChecks = changedComponents.filter(
    (result) => componentOutcomeDirection(result) === "improved",
  ).length;
  const verdict = data
    ? comparisonVerdict({
        data,
        regressedQueries: queryGroups.regressed.length,
        improvedQueries: queryGroups.improved.length,
        regressedChecks,
        improvedChecks,
      })
    : null;
  const resultsComparable = data?.fingerprintMismatch.length === 0;

  return (
    <Dialog open={ids !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>Knowledge settings comparison</DialogTitle>
          <DialogDescription className="sr-only">
            Compare the settings and results from two evaluations.
          </DialogDescription>
          {data &&
            (data.configDiff.length > 0 ? (
              <div className="mt-1 text-left">
                <h3 className="text-sm font-semibold">
                  Changed settings{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    ({data.configDiff.length})
                  </span>
                </h3>
                <div className="mt-2 max-h-36 overflow-y-auto rounded-md border">
                  <div className="sticky top-0 grid grid-cols-[minmax(0,1fr)_minmax(5rem,0.6fr)_minmax(5rem,0.6fr)] gap-3 bg-muted px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    <span>Setting</span>
                    <span>Before</span>
                    <span>After</span>
                  </div>
                  <div className="divide-y">
                    {data.configDiff.map((change) => (
                      <div
                        key={change.key}
                        className="grid grid-cols-[minmax(0,1fr)_minmax(5rem,0.6fr)_minmax(5rem,0.6fr)] gap-3 px-2.5 py-2 text-sm"
                      >
                        <span className="min-w-0 break-words font-medium">
                          {configurationLabel(change.key)}
                        </span>
                        <span
                          className="min-w-0 truncate text-muted-foreground tabular-nums"
                          title={change.a}
                        >
                          {change.a || "Not recorded"}
                        </span>
                        <span
                          className="min-w-0 truncate font-medium tabular-nums"
                          title={change.b}
                        >
                          {change.b || "Not recorded"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <p className="mt-1 text-left text-sm text-muted-foreground">
                No settings changed between these evaluations.
              </p>
            ))}
        </DialogHeader>
        <DialogBody>
          {comparison.isError ? (
            <Alert variant="destructive">
              <CircleX />
              <AlertTitle>Could not load this comparison</AlertTitle>
              <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                <p>Check your connection, then try again.</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void comparison.refetch()}
                >
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          ) : !data ? (
            <p className="text-sm text-muted-foreground">
              {comparison.isLoading
                ? "Comparing..."
                : "Comparison unavailable."}
            </p>
          ) : (
            <div className="space-y-6">
              {verdict && verdict.tone !== "same" && (
                <ComparisonVerdictAlert verdict={verdict} />
              )}

              {(data.components.onlyA.length > 0 ||
                data.components.onlyB.length > 0) && (
                <Alert>
                  <Info />
                  <AlertTitle>Comparison uses shared checks</AlertTitle>
                  <AlertDescription>
                    <p>
                      Results compare {data.components.paired.length}{" "}
                      {data.components.paired.length === 1 ? "check" : "checks"}{" "}
                      run in both evaluations.
                    </p>
                    {data.components.onlyA.length > 0 && (
                      <p>
                        {data.components.onlyA.map(componentLabel).join(", ")}{" "}
                        ran only before and{" "}
                        {data.components.onlyA.length === 1 ? "is" : "are"}{" "}
                        omitted.
                      </p>
                    )}
                    {data.components.onlyB.length > 0 && (
                      <p>
                        {data.components.onlyB.map(componentLabel).join(", ")}{" "}
                        ran only after and{" "}
                        {data.components.onlyB.length === 1 ? "is" : "are"}{" "}
                        omitted.
                      </p>
                    )}
                  </AlertDescription>
                </Alert>
              )}

              {resultsComparable &&
                (data.pairedQueryCount > 0 ? (
                  <ComparisonResults data={data} />
                ) : (
                  <Alert variant="warning">
                    <AlertTriangle />
                    <AlertTitle>No shared test cases</AlertTitle>
                    <AlertDescription>
                      <p>
                        Run the same check in both evaluations to compare
                        results.
                      </p>
                    </AlertDescription>
                  </Alert>
                ))}

              {resultsComparable && changedComponents.length > 0 && (
                <section>
                  <h3 className="mb-3 text-base font-semibold">
                    Check outcome changes ({changedComponents.length})
                  </h3>
                  <div className="divide-y rounded-md border">
                    {changedComponents.map((result) => (
                      <ComponentOutcomeChange
                        key={result.component}
                        result={result}
                      />
                    ))}
                  </div>
                </section>
              )}

              {resultsComparable &&
                data.pairedQueryCount > 0 &&
                (queryGroups.regressed.length > 0 ||
                  queryGroups.improved.length > 0) && (
                  <section>
                    <h3 className="mb-3 text-base font-semibold">
                      Test case results
                    </h3>
                    <div className="space-y-5">
                      <ComparisonQueryGroup
                        title="Regressions"
                        direction="regressed"
                        queries={queryGroups.regressed}
                      />
                      <ComparisonQueryGroup
                        title="Improvements"
                        direction="improved"
                        queries={queryGroups.improved}
                      />
                      {queryGroups.unchanged.length > 0 && (
                        <details className="rounded-md border bg-muted/20">
                          <summary className="cursor-pointer px-3 py-2.5 text-sm font-medium">
                            Show unchanged test cases (
                            {queryGroups.unchanged.length})
                          </summary>
                          <div className="divide-y border-t">
                            {queryGroups.unchanged.map((query) => (
                              <div key={query.id} className="px-3 py-2 text-sm">
                                {query.query}
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
                    </div>
                  </section>
                )}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button">Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ComparisonVerdictAlert({
  verdict,
}: {
  verdict: ReturnType<typeof comparisonVerdict>;
}) {
  const Icon =
    verdict.tone === "regressed"
      ? CircleX
      : verdict.tone === "improved"
        ? CircleCheck
        : verdict.tone === "limited"
          ? AlertTriangle
          : Minus;
  return (
    <Alert
      variant={verdict.tone === "limited" ? "warning" : "default"}
      className={cn(
        verdict.tone === "regressed" &&
          "border-l-2 border-l-destructive bg-muted/30",
        verdict.tone === "improved" &&
          "border-l-2 border-l-emerald-500 bg-muted/30",
        verdict.tone === "same" && "bg-muted/30",
      )}
    >
      <Icon
        className={cn(
          verdict.tone === "regressed" && "text-destructive",
          verdict.tone === "improved" && "text-emerald-600",
        )}
      />
      <AlertTitle>{verdict.title}</AlertTitle>
      <AlertDescription>
        <p>{verdict.description}</p>
      </AlertDescription>
    </Alert>
  );
}

function RunMetricRow({
  label,
  value,
  help,
  docsUrl,
}: {
  label: string;
  value: string;
  help: string;
  docsUrl: string;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-3 px-3 py-2.5">
      <div className="flex items-center gap-1.5">
        <p className="text-sm font-medium">{label}</p>
        <MetricHelp label={label} help={help} docsUrl={docsUrl} />
      </div>
      <p className="text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function RunConfidenceDetails({
  uncertainty,
  bySegment,
}: {
  uncertainty: NonNullable<RunDetail["artifact"]>["uncertainty"];
  bySegment: NonNullable<RunDetail["artifact"]>["bySegment"];
}) {
  const categoryEntries = Object.entries(bySegment?.category ?? {});
  return (
    <details className="overflow-hidden rounded-md border">
      <summary className="cursor-pointer bg-muted/20 px-3 py-2.5 text-sm font-medium">
        Confidence and coverage
      </summary>
      <div className="space-y-3 border-t p-3">
        {uncertainty && (
          <>
            <p className="text-xs text-muted-foreground">
              Deterministic 95% bootstrap intervals. The built-in synthetic
              suite remains diagnostic, not statistically representative.
            </p>
            <div className="overflow-x-auto rounded-md border">
              <Table className="min-w-96">
                <TableHeader>
                  <TableRow>
                    <TableHead>Metric</TableHead>
                    <TableHead>Estimate</TableHead>
                    <TableHead>95% interval</TableHead>
                    <TableHead>Cases</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Object.entries(uncertainty.metrics).map(
                    ([metric, interval]) => (
                      <TableRow key={metric}>
                        <TableCell className="font-medium">{metric}</TableCell>
                        <TableCell className="tabular-nums">
                          {formatPercent(interval.estimate)}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {formatPercent(interval.lower)} –{" "}
                          {formatPercent(interval.upper)}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {interval.n}
                        </TableCell>
                      </TableRow>
                    ),
                  )}
                </TableBody>
              </Table>
            </div>
          </>
        )}
        {categoryEntries.length > 0 && (
          <div>
            <p className="text-xs font-medium">Query categories</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {categoryEntries
                .map(
                  ([category, values]) => `${category}: ${values.queries ?? 0}`,
                )
                .join(" · ")}
            </p>
          </div>
        )}
      </div>
    </details>
  );
}

function ComparisonResults({ data }: { data: EvaluationComparison }) {
  const hitAtFive = data.aggregates["hit@5"];
  const mrr = data.aggregates.mrr;
  const precisionAtFive = data.aggregates["precision@5"];
  const ndcgAtFive = data.aggregates["ndcg@5"];
  const mapAtFive = data.aggregates["map@5"];
  const negativeHitAtFive = data.aggregates["negativeHitRate@5"];
  const noAnswerForcedRetrieval = data.aggregates.noAnswerForcedRetrievalRate;
  const scoreSeparation = data.aggregates.meanScoreMargin;
  const rows: ComparisonResultRowData[] = [];
  if (hitAtFive) {
    rows.push({
      key: "hit@5",
      label: "Hit@5",
      help: "Hit@5 is the percentage of test cases with an expected source among the first five results.",
      docsUrl: HIT_AT_5_DOCS_URL,
      before: formatMetricValue(hitAtFive.a, "percent"),
      after: formatMetricValue(hitAtFive.b, "percent"),
      change: formatRateChange(hitAtFive.a, hitAtFive.b),
      changeDetail: comparisonIntervalLabel(data.uncertainty?.["hit@5"]),
      direction: metricDirection(hitAtFive.delta),
    });
  }
  if (mrr) {
    rows.push({
      key: "mrr",
      label: "MRR",
      description: "Position of the first expected result",
      help: "MRR measures how high the first expected result appears. First is 100%, second is 50%, and not found is 0%.",
      docsUrl: MRR_DOCS_URL,
      before: formatMetricValue(mrr.a, "percent"),
      after: formatMetricValue(mrr.b, "percent"),
      change: formatRateChange(mrr.a, mrr.b),
      changeDetail: comparisonIntervalLabel(data.uncertainty?.mrr),
      direction: metricDirection(mrr.delta),
    });
  }
  if (precisionAtFive) {
    rows.push({
      key: "precision@5",
      label: "Precision@5",
      help: "Percentage of the first five result positions occupied by relevant documents.",
      docsUrl: EVALUATION_METRICS_DOCS_URL,
      before: formatMetricValue(precisionAtFive.a, "percent"),
      after: formatMetricValue(precisionAtFive.b, "percent"),
      change: formatRateChange(precisionAtFive.a, precisionAtFive.b),
      changeDetail: comparisonIntervalLabel(data.uncertainty?.["precision@5"]),
      direction: metricDirection(precisionAtFive.delta),
    });
  }
  if (ndcgAtFive) {
    rows.push({
      key: "ndcg@5",
      label: "nDCG@5",
      help: "Rewards highly relevant documents appearing near the top of the first five results.",
      docsUrl: EVALUATION_METRICS_DOCS_URL,
      before: formatMetricValue(ndcgAtFive.a, "percent"),
      after: formatMetricValue(ndcgAtFive.b, "percent"),
      change: formatRateChange(ndcgAtFive.a, ndcgAtFive.b),
      changeDetail: comparisonIntervalLabel(data.uncertainty?.["ndcg@5"]),
      direction: metricDirection(ndcgAtFive.delta),
    });
  }
  if (mapAtFive) {
    rows.push({
      key: "map@5",
      label: "MAP@5",
      help: "Average precision across answerable test cases within the first five results.",
      docsUrl: EVALUATION_METRICS_DOCS_URL,
      before: formatMetricValue(mapAtFive.a, "percent"),
      after: formatMetricValue(mapAtFive.b, "percent"),
      change: formatRateChange(mapAtFive.a, mapAtFive.b),
      changeDetail: comparisonIntervalLabel(data.uncertainty?.["map@5"]),
      direction: metricDirection(mapAtFive.delta),
    });
  }
  if (negativeHitAtFive) {
    rows.push({
      key: "negativeHitRate@5",
      label: "Negative hit rate@5",
      help: "Percentage of judged test cases where a forbidden result appeared in the first five positions. Lower is better.",
      docsUrl: EVALUATION_METRICS_DOCS_URL,
      before: formatMetricValue(negativeHitAtFive.a, "percent"),
      after: formatMetricValue(negativeHitAtFive.b, "percent"),
      change: formatRateChange(negativeHitAtFive.a, negativeHitAtFive.b),
      direction: metricDirection(-negativeHitAtFive.delta),
    });
  }
  if (noAnswerForcedRetrieval) {
    rows.push({
      key: "noAnswerForcedRetrievalRate",
      label: "No-answer forced retrieval",
      help: "Percentage of no-answer controls where retrieval still returned a result. Lower is better.",
      docsUrl: EVALUATION_METRICS_DOCS_URL,
      before: formatMetricValue(noAnswerForcedRetrieval.a, "percent"),
      after: formatMetricValue(noAnswerForcedRetrieval.b, "percent"),
      change: formatRateChange(
        noAnswerForcedRetrieval.a,
        noAnswerForcedRetrieval.b,
      ),
      direction: metricDirection(-noAnswerForcedRetrieval.delta),
    });
  }
  if (scoreSeparation) {
    rows.push({
      key: "bm25-score-gap",
      label: "BM25 score gap",
      help: "Difference between the expected result's BM25 score and the highest-scoring alternative.",
      docsUrl: BM25_SCORE_GAP_DOCS_URL,
      before: formatMetricValue(scoreSeparation.a, "score"),
      after: formatMetricValue(scoreSeparation.b, "score"),
      change: formatScoreSeparationChange(scoreSeparation.a, scoreSeparation.b),
      direction: metricDirection(scoreSeparation.delta),
    });
  }
  return (
    <section>
      <h3 className="mb-3 text-base font-semibold">Results</h3>
      <div className="space-y-2">
        <ComparisonResultGroup
          title="Regressions"
          direction="regressed"
          rows={rows.filter((row) => row.direction === "regressed")}
          defaultOpen
        />
        <ComparisonResultGroup
          title="Improvements"
          direction="improved"
          rows={rows.filter((row) => row.direction === "improved")}
          defaultOpen
        />
        <ComparisonResultGroup
          title="No change"
          direction="same"
          rows={rows.filter((row) => row.direction === "same")}
        />
      </div>
    </section>
  );
}

type ComparisonResultRowData = {
  key: string;
  label: string;
  description?: string;
  help: string;
  docsUrl: string;
  before: string;
  after: string;
  afterDetail?: string;
  change: string;
  changeDetail?: string;
  direction: ComparisonDirection;
};

function ComparisonResultGroup({
  title,
  direction,
  rows,
  defaultOpen = false,
}: {
  title: string;
  direction: ComparisonDirection;
  rows: ComparisonResultRowData[];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (rows.length === 0) return null;
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="overflow-hidden rounded-md border"
    >
      <summary
        className={cn(
          "cursor-pointer bg-muted/20 px-3 py-2.5 text-sm font-medium",
          direction === "regressed" && "text-destructive",
          direction === "improved" && "text-emerald-600",
        )}
      >
        {title} ({rows.length})
      </summary>
      <div className="border-t">
        <div className="hidden grid-cols-[minmax(0,1fr)_7rem_7rem_8rem] gap-3 bg-muted/30 px-3 py-2 text-[11px] font-medium text-muted-foreground sm:grid">
          <span>Metric</span>
          <span>Before</span>
          <span>After</span>
          <span>Change</span>
        </div>
        <div className="divide-y">
          {rows.map(({ key, ...row }) => (
            <ComparisonResultRow key={key} {...row} />
          ))}
        </div>
      </div>
    </details>
  );
}

function ComparisonResultRow({
  label,
  description,
  help,
  docsUrl,
  before,
  after,
  afterDetail,
  change,
  changeDetail,
  direction,
}: Omit<ComparisonResultRowData, "key">) {
  return (
    <div className="grid gap-3 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_7rem_7rem_8rem] sm:items-start">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="text-sm font-medium">{label}</p>
          <MetricHelp label={label} help={help} docsUrl={docsUrl} />
        </div>
        {description && (
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="grid grid-cols-3 gap-2 sm:contents">
        <ComparisonResultValue label="Before" value={before} />
        <ComparisonResultValue
          label="After"
          value={after}
          detail={afterDetail}
        />
        <ComparisonResultValue
          label="Change"
          value={change}
          detail={changeDetail}
          direction={direction}
        />
      </div>
    </div>
  );
}

function ComparisonResultValue({
  label,
  value,
  detail,
  direction,
}: {
  label: string;
  value: string;
  detail?: string;
  direction?: ComparisonDirection;
}) {
  return (
    <div>
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground sm:hidden">
        {label}
      </p>
      <p
        className={cn(
          "text-sm font-semibold tabular-nums",
          direction === "improved" && "text-emerald-600",
          direction === "regressed" && "text-destructive",
          direction === "same" && "text-muted-foreground",
        )}
      >
        {value}
      </p>
      {detail && (
        <p className="mt-0.5 text-[11px] text-muted-foreground">{detail}</p>
      )}
    </div>
  );
}

function MetricHelp({
  label,
  help,
  docsUrl,
}: {
  label: string;
  help: string;
  docsUrl: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`About ${label}`}
          className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Info className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-2">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{help}</p>
        <ExternalDocsLink href={docsUrl} className="text-xs">
          Read about {label}
        </ExternalDocsLink>
      </PopoverContent>
    </Popover>
  );
}

function ComponentOutcomeChange({
  result,
}: {
  result: EvaluationComparison["componentResults"][number];
}) {
  const direction = componentOutcomeDirection(result);
  return (
    <div className="space-y-2 px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <DirectionBadge direction={direction} />
        <p className="text-sm font-medium">
          {componentLabel(result.component)}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Before:</span>
        <OutcomeBadge status={result.a?.status} />
        <ArrowRight
          className="size-3 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="text-muted-foreground">After:</span>
        <OutcomeBadge status={result.b?.status} />
      </div>
      {result.b?.detail && result.b.detail !== result.a?.detail && (
        <p className="text-xs text-muted-foreground">{result.b.detail}</p>
      )}
    </div>
  );
}

function ComparisonQueryGroup({
  title,
  direction,
  queries,
}: {
  title: string;
  direction: ComparisonDirection;
  queries: ComparisonQuery[];
}) {
  if (queries.length === 0) return null;
  return (
    <div>
      <h5
        className={cn(
          "mb-2 flex items-center gap-2 text-sm font-medium",
          direction === "regressed" && "text-destructive",
          direction === "improved" && "text-emerald-600",
        )}
      >
        {title} ({queries.length})
      </h5>
      <div className="space-y-2">
        {queries.map((query) => (
          <ComparisonQueryRow key={query.id} query={query} />
        ))}
      </div>
    </div>
  );
}

function ComparisonQueryRow({ query }: { query: ComparisonQuery }) {
  const direction = comparisonQueryDirection(query);
  const changedMetrics = Object.entries(query.direction).filter(
    ([metric, metricDirection]) =>
      metric !== "scoreMargin" && metricDirection !== "same",
  );
  return (
    <article
      className={cn(
        "rounded-md border bg-card/50 p-3",
        direction === "regressed" && "border-l-2 border-l-destructive/60",
        direction === "improved" && "border-l-2 border-l-emerald-500/60",
      )}
    >
      <div className="flex flex-wrap items-start gap-2">
        <DirectionBadge direction={direction} />
        <div className="min-w-0 flex-1">
          <h6 className="text-sm font-medium leading-snug">{query.query}</h6>
          <p className="mt-1 text-xs text-muted-foreground">
            {query.component ? componentLabel(query.component) : "Evaluation"}
            {query.expected.length > 0
              ? ` - Expected: ${query.expected.join(", ")}`
              : ""}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t pt-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          Best rank:{" "}
          <strong className="font-medium text-foreground">
            {formatRank(query.a.bestRank)}
          </strong>
          <ArrowRight className="size-3" aria-hidden="true" />
          <strong className="font-medium text-foreground">
            {formatRank(query.b.bestRank)}
          </strong>
        </span>
        {!query.returnedChanged && (
          <span>Results returned: {query.b.returned}</span>
        )}
      </div>

      {(changedMetrics.length > 0 || query.returnedChanged) && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {changedMetrics.map(([metric, metricDirection]) => (
            <QueryMetricDelta
              key={metric}
              metric={metric}
              direction={metricDirection}
              before={queryMetricValue(query.a, metric)}
              after={queryMetricValue(query.b, metric)}
            />
          ))}
          {query.returnedChanged && (
            <QueryMetricDelta
              metric="returned"
              direction="changed"
              before={query.a.returned}
              after={query.b.returned}
            />
          )}
        </div>
      )}
    </article>
  );
}

function QueryMetricDelta({
  metric,
  direction,
  before,
  after,
}: {
  metric: string;
  direction: ComparisonDirection | "changed";
  before: number | null;
  after: number | null;
}) {
  return (
    <div className="rounded-md border bg-muted/20 p-2.5">
      <p className="text-xs font-medium">{comparisonMetricLabel(metric)}</p>
      <div className="mt-2 flex items-baseline gap-2 tabular-nums">
        <span className="text-xs text-muted-foreground">
          {formatQueryMetric(metric, before)}
        </span>
        <ArrowRight
          className="size-3 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="text-sm font-semibold">
          {formatQueryMetric(metric, after)}
        </span>
        <span
          className={cn(
            "ml-auto text-xs font-semibold",
            direction === "regressed" && "text-destructive",
            direction === "improved" && "text-emerald-600",
            direction === "changed" && "text-amber-600",
          )}
        >
          {formatQueryMetricDelta(metric, before, after)}
        </span>
      </div>
    </div>
  );
}

function DirectionBadge({
  direction,
}: {
  direction: ComparisonDirection | "changed";
}) {
  const Icon =
    direction === "improved"
      ? ArrowUp
      : direction === "regressed"
        ? ArrowDown
        : direction === "changed"
          ? AlertTriangle
          : Minus;
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1 capitalize",
        direction === "improved" &&
          "border-emerald-500/30 text-emerald-700 dark:text-emerald-300",
        direction === "regressed" && "border-destructive/30 text-destructive",
        direction === "changed" &&
          "border-amber-500/30 text-amber-700 dark:text-amber-300",
        direction === "same" && "text-muted-foreground",
      )}
    >
      <Icon className="size-3" aria-hidden="true" />
      {direction === "same" ? "No change" : statusLabel(direction)}
    </Badge>
  );
}

function OutcomeBadge({
  status,
}: {
  status?: "passed" | "failed" | "skipped";
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        status === "passed" && "text-emerald-600",
        status === "failed" && "text-destructive",
        (!status || status === "skipped") && "text-muted-foreground",
      )}
    >
      {status ? statusLabel(status) : "Not recorded"}
    </Badge>
  );
}

function RunStatusText({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "font-medium",
        status === "completed" && "text-emerald-600",
        status === "degraded" && "text-amber-600",
        status === "failed" && "text-destructive",
      )}
    >
      {status === "degraded" ? "Completed with issues" : statusLabel(status)}
    </span>
  );
}

function groupComparisonQueries(queries: ComparisonQuery[]): {
  regressed: ComparisonQuery[];
  improved: ComparisonQuery[];
  unchanged: ComparisonQuery[];
} {
  const groups = {
    regressed: [] as ComparisonQuery[],
    improved: [] as ComparisonQuery[],
    unchanged: [] as ComparisonQuery[],
  };
  for (const query of queries) {
    if (!query.changed) {
      groups.unchanged.push(query);
      continue;
    }
    const direction = comparisonQueryDirection(query);
    if (direction === "same") groups.unchanged.push(query);
    else groups[direction].push(query);
  }
  return groups;
}

function comparisonQueryDirection(query: ComparisonQuery): ComparisonDirection {
  if (query.gateMode === "metric-only") return "same";
  return overallDirection(
    Object.fromEntries(
      Object.entries(query.direction).filter(
        ([metric]) => metric !== "scoreMargin",
      ),
    ),
  );
}

function componentOutcomeDirection(
  result: EvaluationComparison["componentResults"][number],
): ComparisonDirection | "changed" {
  if (result.a?.status === "passed" && result.b?.status === "failed") {
    return "regressed";
  }
  if (result.a?.status === "failed" && result.b?.status === "passed") {
    return "improved";
  }
  return "changed";
}

function comparisonVerdict(params: {
  data: EvaluationComparison;
  regressedQueries: number;
  improvedQueries: number;
  regressedChecks: number;
  improvedChecks: number;
}): {
  tone: "limited" | "regressed" | "improved" | "same";
  title: string;
  description: string;
} {
  if (params.data.fingerprintMismatch.length > 0) {
    return {
      tone: "limited",
      title: "Comparison limited",
      description:
        "The corpus or expected test data changed, so the results are not directly comparable.",
    };
  }

  if (params.regressedQueries > 0 || params.regressedChecks > 0) {
    const details: string[] = [];
    if (params.regressedQueries > 0) {
      details.push(
        `${params.regressedQueries} of ${params.data.pairedQueryCount} paired ${params.data.pairedQueryCount === 1 ? "test case" : "test cases"} regressed`,
      );
    }
    if (params.regressedChecks > 0) {
      details.push(
        `${checkCount(params.regressedChecks)} changed from passed to failed`,
      );
    }
    return {
      tone: "regressed",
      title: "Regression detected",
      description: `${details.join(". ")}. Review the highlighted changes before using this configuration.`,
    };
  }

  if (params.data.pairedQueryCount === 0) {
    return {
      tone: "limited",
      title: "Insufficient overlap",
      description:
        "No test case ran with both settings, so the results cannot be compared.",
    };
  }

  if (params.improvedQueries > 0 || params.improvedChecks > 0) {
    const improvements = params.improvedQueries + params.improvedChecks;
    return {
      tone: "improved",
      title: "Improved with no regressions",
      description: `${improvements} measured ${improvements === 1 ? "result improved" : "results improved"}; no regression was detected.`,
    };
  }

  return {
    tone: "same",
    title: "No pass/fail changes",
    description: `${testCaseCountLabel(params.data.pairedQueryCount)} kept the same result with both settings.`,
  };
}

function metricDirection(delta: number): ComparisonDirection {
  if (Math.abs(delta) < 1e-9) return "same";
  return delta > 0 ? "improved" : "regressed";
}

function formatMetricValue(value: number, format: "percent" | "score"): string {
  if (format === "percent") return `${(value * 100).toFixed(1)}%`;
  return value.toFixed(4);
}

function comparisonIntervalLabel(
  interval: EvaluationComparison["uncertainty"][string] | undefined,
): string | undefined {
  if (!interval) return undefined;
  return `95%: ${(interval.lower * 100).toFixed(1)} to ${(interval.upper * 100).toFixed(1)} pp`;
}

function formatRateChange(before: number, after: number): string {
  const delta = after - before;
  const percentage = delta * 100;
  return `${percentage > 0 ? "+" : ""}${percentage.toFixed(1)}%`;
}

function formatScoreSeparationChange(before: number, after: number): string {
  const delta = after - before;
  if (Math.abs(delta) < 1e-9) return "0.0%";
  if (Math.abs(before) < 1e-9 || Math.sign(before) !== Math.sign(after)) {
    return "Changed sign";
  }
  const percentage = (delta / Math.abs(before)) * 100;
  return `${percentage > 0 ? "+" : ""}${percentage.toFixed(1)}%`;
}

function queryMetricValue(
  side: ComparisonQuery["a"],
  metric: string,
): number | null {
  const [, cutoff] = metric.split("@");
  if (metric.startsWith("hit@")) return side.hit[cutoff] ?? null;
  if (metric.startsWith("recall@")) return side.recall[cutoff] ?? null;
  if (metric.startsWith("evidence@")) return side.evidence[cutoff] ?? null;
  if (metric === "mrr") return side.reciprocalRank;
  if (metric === "scoreMargin") return side.scoreMargin;
  if (metric === "returned") return side.returned;
  return null;
}

function comparisonMetricLabel(metric: string): string {
  if (metric === "mrr") return "MRR";
  if (metric === "scoreMargin") return "BM25 score gap";
  if (metric === "returned") return "Results returned";
  if (metric.startsWith("hit@")) return metric.replace("hit", "Hit");
  if (metric.startsWith("recall@")) return metric.replace("recall", "Recall");
  if (metric.startsWith("evidence@")) {
    return metric.replace("evidence", "Evidence");
  }
  return componentLabel(metric);
}

function formatQueryMetric(metric: string, value: number | null): string {
  if (value === null) return "Not recorded";
  if (
    metric.startsWith("hit@") ||
    metric.startsWith("recall@") ||
    metric.startsWith("evidence@") ||
    metric === "mrr"
  ) {
    return `${Math.round(value * 100)}%`;
  }
  if (metric === "returned") return String(value);
  return value.toFixed(metric === "scoreMargin" ? 4 : 3);
}

function formatQueryMetricDelta(
  metric: string,
  before: number | null,
  after: number | null,
): string {
  if (before === null || after === null) return "Changed";
  const delta = after - before;
  if (metric === "returned") return `${delta > 0 ? "+" : ""}${delta}`;
  if (metric === "scoreMargin") {
    return formatScoreSeparationChange(before, after);
  }
  return formatRateChange(before, after);
}

function formatRank(rank: number | null): string {
  return rank === null ? "Not found" : String(rank);
}

function configurationLabel(key: string): string {
  return CONFIGURATION_LABELS[key] ?? componentLabel(key);
}

function runDialogTitle(status: string): string {
  switch (status) {
    case "queued":
      return "Evaluation queued";
    case "running":
      return "Evaluation running";
    case "cancel_requested":
      return "Stopping evaluation";
    case "cancelled":
      return "Evaluation cancelled";
    case "completed":
      return "Evaluation completed";
    case "degraded":
      return "Evaluation completed with issues";
    case "blocked":
      return "Evaluation blocked";
    case "failed":
      return "Evaluation failed";
    default:
      return "Knowledge configuration evaluation";
  }
}

function isActive(status: string): boolean {
  return ["queued", "running", "cancel_requested"].includes(status);
}

function progressPercent(run: RunSummary | RunDetail): number {
  if (run.progressTotal <= 0) return run.status === "queued" ? 0 : 5;
  return Math.min(
    100,
    Math.round((run.progressCurrent / run.progressTotal) * 100),
  );
}

function statusLabel(status: string): string {
  return status
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function componentSelectionAndBillingExplanation(
  component: ComponentInfo,
  selected: boolean,
  changedForDraft = false,
): string {
  const billing = componentBillingExplanation(component);
  if (changedForDraft) {
    const selection = selected
      ? "Selected because its configuration changed for this evaluation run."
      : "Not selected for this run even though its configuration changed.";
    return `${selection} ${billing}`;
  }
  if (selected) return billing;
  const selection = component.selectedByDefault
    ? "Not selected for this run; it is new or changed since the last evaluation."
    : "Not selected by default because it was already tested with the current settings.";
  return `${selection} ${billing}`;
}

function evaluationDraftChangedComponents(params: {
  components: ComponentInfo[];
  bm25Changed: boolean;
  embeddingChanged: boolean;
  rerankerChanged: boolean;
  ocrChanged: boolean;
  contextualRetrievalChanged: boolean;
}): ComponentId[] {
  const changed = new Set<ComponentId>();
  if (params.bm25Changed) {
    for (const component of EVALUATION_COMPONENTS_BY_CONFIGURATION[
      "keyword-ranking"
    ]) {
      changed.add(component);
    }
  }
  if (params.embeddingChanged) {
    for (const component of EVALUATION_COMPONENTS_BY_CONFIGURATION.embedding) {
      changed.add(component);
    }
  }
  if (params.rerankerChanged) {
    for (const component of EVALUATION_COMPONENTS_BY_CONFIGURATION.reranking) {
      changed.add(component);
    }
  }
  if (params.ocrChanged) {
    for (const component of EVALUATION_COMPONENTS_BY_CONFIGURATION.ocr) {
      changed.add(component);
    }
  }
  if (params.contextualRetrievalChanged) {
    for (const component of EVALUATION_COMPONENTS_BY_CONFIGURATION[
      "contextual-retrieval"
    ]) {
      changed.add(component);
    }
  }
  return params.components
    .filter(
      (component) => component.status === "active" && changed.has(component.id),
    )
    .map((component) => component.id);
}

function modelPairChanged(
  current: EvaluationModelPair,
  initial: EvaluationModelPair,
): boolean {
  return (
    current.chatApiKeyId !== initial.chatApiKeyId ||
    current.model !== initial.model
  );
}

function modelPairSignature(pair: EvaluationModelPair): string {
  return `${pair.chatApiKeyId ?? ""}:${pair.model ?? ""}`;
}

function componentBillingExplanation(component: ComponentInfo): string {
  if (component.mode !== "online") {
    return "No provider calls or model billing.";
  }
  switch (component.id) {
    case "text-embedding":
    case "image-embedding":
    case "hybrid-retrieval":
      return "Calls the configured embedding model provider; provider charges may apply.";
    case "reranking":
      return "Calls the configured embedding and reranking model providers; provider charges may apply.";
    case "query-expansion":
      return "Calls the configured query-expansion model provider; provider charges may apply.";
    case "contextual-retrieval":
      return "Calls the configured embedding and contextual retrieval model providers; provider charges may apply.";
    case "ocr":
      return "Calls the configured embedding and OCR model providers; provider charges may apply.";
    default:
      return "Calls a configured model provider; provider charges may apply.";
  }
}

function validBm25Overrides(params: {
  bm25K1: string;
  bm25B: string;
}): boolean {
  const k1 = Number(params.bm25K1);
  const b = Number(params.bm25B);
  return (
    params.bm25K1.trim() !== "" &&
    params.bm25B.trim() !== "" &&
    Number.isFinite(k1) &&
    Number.isFinite(b) &&
    k1 >= BM25_K1_MIN &&
    k1 <= BM25_K1_MAX &&
    b >= BM25_B_MIN &&
    b <= BM25_B_MAX
  );
}

function completeModelPair(
  pair: EvaluationModelPair,
): pair is { chatApiKeyId: string; model: string } {
  return Boolean(pair.chatApiKeyId && pair.model);
}

function evaluationSettingsRequirements(components: ComponentId[]): {
  bm25: boolean;
  embedding: boolean;
  reranker: boolean;
  ocr: boolean;
  contextualRetrieval: boolean;
} {
  const selected = new Set(components);
  return {
    bm25: selected.has("keyword-ranking"),
    embedding: [
      "text-embedding",
      "image-embedding",
      "hybrid-retrieval",
      "reranking",
      "query-expansion",
      "contextual-retrieval",
      "ocr",
    ].some((component) => selected.has(component as ComponentId)),
    reranker: ["reranking", "query-expansion", "contextual-retrieval"].some(
      (component) => selected.has(component as ComponentId),
    ),
    ocr: selected.has("ocr"),
    contextualRetrieval: selected.has("contextual-retrieval"),
  };
}

function evaluationDraftConfigurationIssues({
  components,
  bm25Valid,
  embedding,
  reranker,
  ocr,
  contextualRetrievalMode,
}: {
  components: ComponentInfo[];
  bm25Valid: boolean;
  embedding: EvaluationModelPair;
  reranker: EvaluationModelPair;
  ocr: EvaluationModelPair;
  contextualRetrievalMode: ContextualRetrievalMode;
}): Partial<Record<ComponentId, EvaluationConfigurationIssue>> {
  const issues: Partial<Record<ComponentId, EvaluationConfigurationIssue>> = {};
  for (const component of components) {
    const requirements = evaluationSettingsRequirements([component.id]);
    const missing: string[] = [];
    const targets: EvaluationConfigurationTarget[] = [];
    if (requirements.bm25 && !bm25Valid) {
      missing.push("valid keyword-ranking values");
      targets.push("keyword-ranking");
    }
    if (requirements.embedding && !completeModelPair(embedding)) {
      missing.push("an embedding key and model");
      targets.push("embedding");
    }
    if (requirements.reranker && !completeModelPair(reranker)) {
      missing.push("a reranking key and model");
      targets.push("reranking");
    }
    if (requirements.ocr && !completeModelPair(ocr)) {
      missing.push("an OCR key and model");
      targets.push("ocr");
    }
    if (
      requirements.contextualRetrieval &&
      contextualRetrievalMode === "disabled"
    ) {
      missing.push("context generation");
      targets.push("contextual-retrieval");
    }
    if (missing.length > 0) {
      issues[component.id] = {
        detail: `Missing configuration: ${formatList(missing)}.`,
        targets,
      };
    }
  }
  return issues;
}

function formatList(items: string[]): string {
  if (items.length < 2) return items[0] ?? "the required settings";
  if (items.length === 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function componentLabel(component: string): string {
  return component
    .replaceAll("-", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function bestRank(ranks: Record<string, number | null>): number | null {
  const values = Object.values(ranks).filter(
    (rank): rank is number => rank !== null,
  );
  return values.length > 0 ? Math.min(...values) : null;
}

function formatResultPosition(rank: number | null): string {
  if (rank === null) return "Not found";
  const tens = rank % 100;
  const suffix =
    tens >= 11 && tens <= 13
      ? "th"
      : rank % 10 === 1
        ? "st"
        : rank % 10 === 2
          ? "nd"
          : rank % 10 === 3
            ? "rd"
            : "th";
  return `${rank}${suffix} result`;
}

function formatPercent(value: number | undefined): string {
  return `${Math.round((value ?? 0) * 100)}%`;
}

function overallDirection(
  directions: Record<string, "improved" | "regressed" | "same">,
): "improved" | "regressed" | "same" {
  const values = Object.values(directions);
  if (values.includes("regressed")) return "regressed";
  if (values.includes("improved")) return "improved";
  return "same";
}

function checkCount(count: number): string {
  return `${count} check${count === 1 ? "" : "s"}`;
}

function testCaseCountLabel(count: number): string {
  return `${count} test case${count === 1 ? "" : "s"}`;
}

function selectedChecksLabel(count: number): string {
  return `${checkCount(count)} selected`;
}

const CONFIGURATION_LABELS: Record<string, string> = {
  bm25K1: "BM25 term saturation (k1)",
  bm25B: "BM25 length normalization (b)",
  bm25RecallCap: "BM25 candidate limit",
  hybridSearchEnabled: "Hybrid search",
  searchStatementTimeoutMillis: "Search timeout",
  "query.limit": "Query limit",
  chunkSizeTokens: "Chunk size",
  contextualRetrievalEnabled: "Contextual retrieval",
  contextExpansionRadius: "Context expansion radius",
  ocrMaxPagesPerDocument: "OCR page limit",
  embedding: "Text embedding model",
  "embedding.provider": "Embedding provider",
  "embedding.model": "Embedding model",
  imageEmbedding: "Image embedding model",
  reranker: "Reranking model",
  "reranker.provider": "Reranking provider",
  "reranker.model": "Reranking model",
  ocr: "OCR model",
  "ocr.provider": "Document OCR provider",
  "ocr.model": "Document OCR model",
};

function downloadArtifact(run: RunDetail): void {
  if (!run.artifact) return;
  const blob = new Blob([JSON.stringify(run.artifact, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `knowledge-evaluation-${run.id}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
