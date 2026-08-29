"use client";

import {
  BM25_B_MAX,
  BM25_B_MIN,
  BM25_K1_MAX,
  BM25_K1_MIN,
  type ContextualRetrievalMode,
  DocsPage,
  getDocsUrl,
  getKnowledgeRerankerKind,
  OCR_PDF_INPUT_PROVIDERS,
} from "@archestra/shared";
import {
  ArrowUpRight,
  CheckCircle2,
  Loader2,
  Plus,
  Trash2,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { KnowledgeModelCapabilityNotice } from "@/app/knowledge/_parts/embedding-model-image-support-notice";
import { ExternalDocsLink } from "@/components/external-docs-link";
import {
  LlmModelSearchableSelect,
  type LlmModelSelectOption,
} from "@/components/llm-model-select";
import { LlmProviderApiKeyDropdown } from "@/components/llm-provider-api-key-dropdown";
import { PROVIDER_CONFIG } from "@/components/llm-provider-api-key-form";
import { LoadingState } from "@/components/loading";
import { Button } from "@/components/ui/button";
import { CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { isPersonalSubscription } from "@/lib/llm-key-subscription";
import {
  type LlmModel,
  useEmbeddingModels,
  useLlmModels,
  useModelsWithApiKeys,
} from "@/lib/llm-models.query";
import { useAvailableLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { cn } from "@/lib/utils";
import { KnowledgeSettingsRow } from "./knowledge-settings-row";
import type { ConnectionStatus } from "./knowledge-validation";

export function KnowledgeConnectionActions({
  configured,
  status,
  onTest,
  disabled = false,
  clearLabel,
  onClear,
  clearVariant = "outline",
}: {
  configured: boolean;
  status: ConnectionStatus;
  onTest: () => void;
  disabled?: boolean;
  clearLabel?: string;
  onClear?: () => void;
  clearVariant?: "outline" | "destructive";
}) {
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {configured && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || status === "testing"}
          onClick={onTest}
        >
          <TestConnectionIcon status={status} />
          <span>Test connection</span>
        </Button>
      )}
      {clearLabel && onClear && (
        <Button
          type="button"
          variant={clearVariant}
          size="sm"
          disabled={disabled}
          onClick={onClear}
        >
          <Trash2 className="mr-1 size-3.5" />
          <span>{clearLabel}</span>
        </Button>
      )}
    </div>
  );
}

const KNOWLEDGE_MODEL_POPOVER_CLASS =
  "w-max min-w-[var(--radix-popover-trigger-width)] max-w-[min(32rem,calc(100vw-2rem))]";
const KNOWLEDGE_MODEL_POPOVER_LIST_CLASS =
  "max-h-[min(220px,calc(var(--radix-popover-content-available-height)-3rem))]";

const SETUP_HIGHLIGHT_CLASS = "ring-2 ring-primary/50";

function toKnowledgeModelSelectOption(model: LlmModel): LlmModelSelectOption {
  return {
    value: model.id,
    model: model.displayName ?? model.id,
    modelId: model.id,
    provider: model.provider,
    description: model.displayName === model.id ? undefined : model.id,
    capabilities: model.capabilities,
    isFree: model.isFree,
    isBest: model.isBest,
  };
}

export function getEmbeddingCapableKeyIds(
  models:
    | Array<{
        embeddingDimensions?: number | null;
        apiKeys: Array<{ id: string; provider?: string }>;
      }>
    | undefined,
): Set<string> {
  const ids = new Set<string>();
  for (const model of models ?? []) {
    if (model.embeddingDimensions == null) continue;
    for (const key of model.apiKeys) {
      const providerConfig = key.provider
        ? PROVIDER_CONFIG[key.provider as keyof typeof PROVIDER_CONFIG]
        : undefined;
      if (providerConfig?.supportsEmbeddings === false) continue;
      ids.add(key.id);
    }
  }
  return ids;
}

export function KnowledgeApiKeySelector({
  value,
  onChange,
  disabled,
  label,
  pulse,
  allowedKeyIds,
  autoSelectFirstKey = true,
  onAddKey,
  triggerAriaLabel,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  disabled: boolean;
  label: string;
  pulse?: boolean;
  allowedKeyIds?: Set<string>;
  autoSelectFirstKey?: boolean;
  onAddKey: () => void;
  triggerAriaLabel?: string;
}) {
  const { data: apiKeys, isPending } = useAvailableLlmProviderApiKeys();
  const [apiKeySelectorOpen, setApiKeySelectorOpen] = useState(false);
  const prevSelectableCountRef = useRef<number | null>(null);

  const organizationKeys = (apiKeys ?? []).filter(
    (key) => !isPersonalSubscription(key),
  );
  const keys = allowedKeyIds
    ? organizationKeys.filter((key) => allowedKeyIds.has(key.id))
    : organizationKeys;

  useEffect(() => {
    if (isPending) return;
    const previousCount = prevSelectableCountRef.current;
    prevSelectableCountRef.current = keys.length;

    if (
      autoSelectFirstKey &&
      previousCount === 0 &&
      keys.length > 0 &&
      !value
    ) {
      onChange(keys[0].id);
    }
  }, [keys, value, onChange, isPending, autoSelectFirstKey]);

  if (isPending) return <LoadingState variant="compact" />;

  if (keys.length === 0) {
    return disabled ? null : (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={cn(pulse && SETUP_HIGHLIGHT_CLASS)}
        onClick={onAddKey}
      >
        <Plus className="h-3 w-3 mr-1" />
        Add LLM Provider Key
      </Button>
    );
  }

  return (
    <LlmProviderApiKeyDropdown
      availableKeys={keys}
      selectedApiKeyId={value}
      disabled={disabled}
      open={apiKeySelectorOpen}
      onOpenChange={setApiKeySelectorOpen}
      onSelectKey={(keyId) => {
        onChange(keyId);
        setApiKeySelectorOpen(false);
      }}
      triggerVariant="select"
      triggerClassName={cn("w-full", pulse && SETUP_HIGHLIGHT_CLASS)}
      popoverClassName="w-[var(--radix-popover-trigger-width)]"
      emptyTriggerLabel={`Select ${label}...`}
      triggerAriaLabel={triggerAriaLabel}
    />
  );
}

export function EmbeddingModelSelector({
  value,
  onChange,
  disabled,
  selectedKeyId,
  pulse,
  triggerAriaLabel,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  disabled: boolean;
  selectedKeyId: string | null;
  pulse?: boolean;
  triggerAriaLabel?: string;
}) {
  const { data: apiKeys } = useAvailableLlmProviderApiKeys();
  const { data: models = [], isPending: modelsLoading } =
    useEmbeddingModels(selectedKeyId);
  const selectedKey = apiKeys?.find((key) => key.id === selectedKeyId);

  if (!selectedKeyId) {
    return (
      <LlmModelSearchableSelect
        value=""
        onValueChange={() => {}}
        placeholder="Select an embedding API key first..."
        options={[]}
        className="w-full"
        disabled
        triggerAriaLabel={triggerAriaLabel}
      />
    );
  }

  if (modelsLoading) return <LoadingState variant="compact" />;

  return (
    <LlmModelSearchableSelect
      value={value ?? ""}
      onValueChange={(model) => onChange(model || null)}
      options={models.map((model) => ({
        ...toKnowledgeModelSelectOption(model),
        badge: model.embeddingDimensions
          ? `${model.embeddingDimensions} dims`
          : undefined,
      }))}
      placeholder="Select embedding model..."
      searchPlaceholder="Search embedding models..."
      emptyMessage={
        selectedKey
          ? `No embedding models detected for "${selectedKey.name}".`
          : "Select an embedding API key first."
      }
      className={cn("w-full", pulse && SETUP_HIGHLIGHT_CLASS)}
      popoverContentClassName={KNOWLEDGE_MODEL_POPOVER_CLASS}
      popoverListClassName={KNOWLEDGE_MODEL_POPOVER_LIST_CLASS}
      popoverSide="bottom"
      popoverAlign="end"
      truncateOptionLabels={false}
      disabled={disabled || !selectedKeyId}
      triggerAriaLabel={triggerAriaLabel}
    />
  );
}

export function RerankerModelSelector({
  value,
  onChange,
  disabled,
  selectedKeyId,
  pulse,
  triggerAriaLabel,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  disabled: boolean;
  selectedKeyId: string | null;
  pulse?: boolean;
  triggerAriaLabel?: string;
}) {
  const { data: models = [], isPending: modelsLoading } = useLlmModels({
    apiKeyId: selectedKeyId ?? undefined,
    purpose: "knowledge-reranker",
    enabled: Boolean(selectedKeyId),
  });

  useEffect(() => {
    if (modelsLoading || !value || models.some((model) => model.id === value)) {
      return;
    }
    onChange(null);
  }, [models, modelsLoading, onChange, value]);

  if (!selectedKeyId) {
    return (
      <LlmModelSearchableSelect
        value=""
        onValueChange={() => {}}
        placeholder="Select a reranker API key first..."
        options={[]}
        className="w-full"
        disabled
        triggerAriaLabel={triggerAriaLabel}
      />
    );
  }

  if (modelsLoading) return <LoadingState variant="compact" />;

  return (
    <LlmModelSearchableSelect
      value={value ?? ""}
      onValueChange={(model) => onChange(model || null)}
      options={models.map(toKnowledgeModelSelectOption)}
      placeholder="Select reranking model..."
      className={cn("w-full", pulse && SETUP_HIGHLIGHT_CLASS)}
      popoverContentClassName={KNOWLEDGE_MODEL_POPOVER_CLASS}
      popoverListClassName={KNOWLEDGE_MODEL_POPOVER_LIST_CLASS}
      popoverSide="bottom"
      popoverAlign="end"
      truncateOptionLabels={false}
      disabled={disabled}
      triggerAriaLabel={triggerAriaLabel}
    />
  );
}

export function OcrModelSelector({
  value,
  onChange,
  disabled,
  selectedKeyId,
  triggerAriaLabel,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  disabled: boolean;
  selectedKeyId: string | null;
  triggerAriaLabel?: string;
}) {
  const { data: allModels = [], isPending: modelsLoading } = useLlmModels({
    apiKeyId: selectedKeyId ?? undefined,
    enabled: Boolean(selectedKeyId),
  });
  const models = useMemo(
    () =>
      allModels.filter((model) => {
        const inputModalities = model.capabilities?.inputModalities;
        return (
          inputModalities?.includes("pdf") || inputModalities?.includes("image")
        );
      }),
    [allModels],
  );

  if (!selectedKeyId) {
    return (
      <LlmModelSearchableSelect
        value=""
        onValueChange={() => {}}
        placeholder="Select an OCR API key first..."
        options={[]}
        className="w-full"
        disabled
        triggerAriaLabel={triggerAriaLabel}
      />
    );
  }

  if (modelsLoading) return <LoadingState variant="compact" />;

  return (
    <LlmModelSearchableSelect
      value={value ?? ""}
      onValueChange={(model) => onChange(model || null)}
      options={models.map(toKnowledgeModelSelectOption)}
      placeholder="Select vision model..."
      searchPlaceholder="Search vision models..."
      emptyMessage="No vision-capable models for this key's provider. Mark your model's image or PDF input modality in LLM Providers > Models."
      className="w-full"
      popoverContentClassName={KNOWLEDGE_MODEL_POPOVER_CLASS}
      popoverListClassName={KNOWLEDGE_MODEL_POPOVER_LIST_CLASS}
      popoverSide="bottom"
      popoverAlign="end"
      truncateOptionLabels={false}
      disabled={disabled}
      triggerAriaLabel={triggerAriaLabel}
    />
  );
}

export type KnowledgeModelPair = {
  chatApiKeyId: string | null;
  model: string | null;
};

export type KnowledgeConfigurationSection =
  | "embedding"
  | "search-ranking"
  | "ocr";

export function KnowledgeConfigurationFields({
  sections = ["embedding", "search-ranking", "ocr"],
  embedding,
  onEmbeddingChange,
  reranker,
  onRerankerChange,
  ocr,
  onOcrChange,
  bm25K1,
  bm25B,
  onBm25K1Change,
  onBm25BChange,
  onBm25K1Blur,
  onBm25BBlur,
  contextualRetrievalMode,
  onContextualRetrievalModeChange,
  onAddApiKey,
  disabled = false,
  showTopLevelHeadings = true,
  showDescriptions = true,
  idPrefix = "",
  required = {},
  keywordStatus,
  embeddingAfterFields,
  rerankerAfterFields,
  contextualAfterFields,
  ocrAfterFields,
}: {
  sections?: KnowledgeConfigurationSection[];
  embedding: KnowledgeModelPair;
  onEmbeddingChange: (value: KnowledgeModelPair) => void;
  reranker: KnowledgeModelPair;
  onRerankerChange: (value: KnowledgeModelPair) => void;
  ocr: KnowledgeModelPair;
  onOcrChange: (value: KnowledgeModelPair) => void;
  bm25K1: string;
  bm25B: string;
  onBm25K1Change: (value: string) => void;
  onBm25BChange: (value: string) => void;
  onBm25K1Blur?: () => void;
  onBm25BBlur?: () => void;
  contextualRetrievalMode: ContextualRetrievalMode;
  onContextualRetrievalModeChange: (value: ContextualRetrievalMode) => void;
  onAddApiKey: (purpose: "embedding" | "reranking" | "ocr") => void;
  disabled?: boolean;
  showTopLevelHeadings?: boolean;
  showDescriptions?: boolean;
  idPrefix?: string;
  required?: Partial<Record<"embedding" | "reranker" | "ocr", boolean>>;
  keywordStatus?: ReactNode;
  embeddingAfterFields?: ReactNode;
  rerankerAfterFields?: ReactNode;
  contextualAfterFields?: ReactNode;
  ocrAfterFields?: ReactNode;
}) {
  const apiKeysQuery = useAvailableLlmProviderApiKeys();
  const modelsWithApiKeysQuery = useModelsWithApiKeys({ toastOnError: false });
  const embeddingCapableKeyIds = useMemo(
    () => getEmbeddingCapableKeyIds(modelsWithApiKeysQuery.data),
    [modelsWithApiKeysQuery.data],
  );
  const ocrCapableKeyIds = useMemo(() => {
    const ids = new Set<string>();
    for (const key of apiKeysQuery.data ?? []) {
      if (
        OCR_PDF_INPUT_PROVIDERS.includes(
          key.provider as (typeof OCR_PDF_INPUT_PROVIDERS)[number],
        )
      ) {
        ids.add(key.id);
      }
    }
    return ids;
  }, [apiKeysQuery.data]);
  const rerankerProvider = apiKeysQuery.data?.find(
    (apiKey) => apiKey.id === reranker.chatApiKeyId,
  )?.provider;
  const nativeReranker = Boolean(
    rerankerProvider &&
      reranker.model &&
      getKnowledgeRerankerKind({
        provider: rerankerProvider,
        model: reranker.model,
      }) === "native-rerank",
  );
  const sectionId = (id: string) => `${idPrefix}${id}`;
  const renderedSections: ReactNode[] = [];

  if (sections.includes("embedding")) {
    renderedSections.push(
      <section
        key="embedding"
        id={sectionId("embedding-configuration")}
        tabIndex={idPrefix ? -1 : undefined}
        className="flex scroll-mt-4 flex-col gap-3 outline-none"
      >
        {showTopLevelHeadings && <EmbeddingConfigurationSectionHeader />}
        <div className="flex flex-col gap-4">
          <KnowledgeSettingsRow label="Key">
            <KnowledgeApiKeySelector
              value={embedding.chatApiKeyId}
              onChange={(chatApiKeyId) =>
                onEmbeddingChange({ chatApiKeyId, model: null })
              }
              disabled={disabled}
              label="embedding API key"
              allowedKeyIds={embeddingCapableKeyIds}
              onAddKey={() => onAddApiKey("embedding")}
              triggerAriaLabel={idPrefix ? "Embedding API key" : undefined}
              pulse={required.embedding && !embedding.chatApiKeyId}
            />
          </KnowledgeSettingsRow>
          <KnowledgeSettingsRow label="Model">
            <EmbeddingModelSelector
              value={embedding.model}
              onChange={(model) => onEmbeddingChange({ ...embedding, model })}
              disabled={disabled}
              selectedKeyId={embedding.chatApiKeyId}
              triggerAriaLabel={idPrefix ? "Embedding model" : undefined}
              pulse={Boolean(
                required.embedding &&
                  embedding.chatApiKeyId &&
                  !embedding.model,
              )}
            />
          </KnowledgeSettingsRow>
          <EmbeddingModelHelp />
          {embeddingAfterFields}
        </div>
      </section>,
    );
  }

  if (sections.includes("search-ranking")) {
    renderedSections.push(
      <section key="search-ranking" className="flex flex-col gap-4">
        {showTopLevelHeadings && <SearchRankingConfigurationSectionHeader />}
        <div className="flex flex-col gap-6">
          <section
            id={sectionId("reranking-configuration")}
            tabIndex={idPrefix ? -1 : undefined}
            className="flex scroll-mt-4 flex-col gap-3 outline-none"
          >
            <RerankingSectionHeader showDescription={showDescriptions} />
            <div className="flex flex-col gap-4">
              <KnowledgeSettingsRow label="Key">
                <KnowledgeApiKeySelector
                  value={reranker.chatApiKeyId}
                  onChange={(chatApiKeyId) =>
                    onRerankerChange({ chatApiKeyId, model: null })
                  }
                  disabled={disabled}
                  label="reranker API key"
                  onAddKey={() => onAddApiKey("reranking")}
                  triggerAriaLabel={idPrefix ? "Reranking API key" : undefined}
                  pulse={required.reranker && !reranker.chatApiKeyId}
                />
              </KnowledgeSettingsRow>
              <KnowledgeSettingsRow label="Model">
                <RerankerModelSelector
                  value={reranker.model}
                  onChange={(model) => onRerankerChange({ ...reranker, model })}
                  disabled={disabled}
                  selectedKeyId={reranker.chatApiKeyId}
                  triggerAriaLabel={idPrefix ? "Reranking model" : undefined}
                  pulse={Boolean(
                    required.reranker &&
                      reranker.chatApiKeyId &&
                      !reranker.model,
                  )}
                />
              </KnowledgeSettingsRow>
              {reranker.model && rerankerProvider && (
                <KnowledgeModelCapabilityNotice
                  modelKey={`${rerankerProvider}/${reranker.model}`}
                  dismissalPrefix="knowledge-reranker-kind-notice-dismissed-model"
                  showSettingsLink={false}
                >
                  {nativeReranker
                    ? "Uses a dedicated cross-encoder rerank API. Query expansion and contextual retrieval require an LLM reranker and are unavailable."
                    : "Uses an LLM to score passages. The native cross-encoder evaluation requires a model and provider served through a supported native rerank API."}{" "}
                  <a
                    href={getDocsUrl(
                      DocsPage.PlatformKnowledge,
                      "native-cross-encoder-and-llm-reranking",
                    )}
                    target="_blank"
                    rel="noreferrer"
                    className="text-foreground underline decoration-dotted underline-offset-4 hover:decoration-solid"
                  >
                    Learn more
                  </a>
                </KnowledgeModelCapabilityNotice>
              )}
              {rerankerAfterFields}
            </div>
          </section>
          <Separator />
          <section
            id={sectionId("keyword-ranking")}
            tabIndex={idPrefix ? -1 : undefined}
            className="flex scroll-mt-4 flex-col gap-3 outline-none"
          >
            <KeywordRankingSectionHeader
              status={keywordStatus}
              showDescription={showDescriptions}
            />
            <KnowledgeBm25Fields
              bm25K1={bm25K1}
              bm25B={bm25B}
              onBm25K1Change={onBm25K1Change}
              onBm25BChange={onBm25BChange}
              onBm25K1Blur={onBm25K1Blur}
              onBm25BBlur={onBm25BBlur}
              disabled={disabled}
              idPrefix={sectionId("bm25")}
            />
          </section>
          <Separator />
          <section
            id={sectionId("contextual-retrieval")}
            tabIndex={idPrefix ? -1 : undefined}
            className="flex scroll-mt-4 flex-col gap-3 outline-none"
          >
            <ContextualRetrievalSectionHeader
              showDescription={showDescriptions}
            />
            <KnowledgeSettingsRow label="Context generation">
              <ContextualRetrievalModeSelector
                value={contextualRetrievalMode}
                onChange={onContextualRetrievalModeChange}
                disabled={disabled}
              />
            </KnowledgeSettingsRow>
            {contextualAfterFields}
          </section>
        </div>
      </section>,
    );
  }

  if (sections.includes("ocr")) {
    renderedSections.push(
      <section
        key="ocr"
        id={sectionId("document-ocr")}
        tabIndex={idPrefix ? -1 : undefined}
        className="flex scroll-mt-4 flex-col gap-3 outline-none"
      >
        {showTopLevelHeadings && <DocumentOcrSectionHeader />}
        <div className="flex flex-col gap-4">
          <KnowledgeSettingsRow label="Key">
            <KnowledgeApiKeySelector
              value={ocr.chatApiKeyId}
              onChange={(chatApiKeyId) =>
                onOcrChange({ chatApiKeyId, model: null })
              }
              disabled={disabled}
              label="OCR API key"
              allowedKeyIds={ocrCapableKeyIds}
              autoSelectFirstKey={false}
              onAddKey={() => onAddApiKey("ocr")}
              triggerAriaLabel={idPrefix ? "Document OCR API key" : undefined}
              pulse={required.ocr && !ocr.chatApiKeyId}
            />
          </KnowledgeSettingsRow>
          <KnowledgeSettingsRow label="Model">
            <OcrModelSelector
              value={ocr.model}
              onChange={(model) => onOcrChange({ ...ocr, model })}
              disabled={disabled}
              selectedKeyId={ocr.chatApiKeyId}
              triggerAriaLabel={idPrefix ? "Document OCR model" : undefined}
            />
          </KnowledgeSettingsRow>
          <OcrModelHelp />
          {ocrAfterFields}
        </div>
      </section>,
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {renderedSections.map((section, index) => (
        <div key={sections[index]} className="contents">
          {index > 0 && <Separator />}
          {section}
        </div>
      ))}
    </div>
  );
}

export function ContextualRetrievalModeSelector({
  value,
  onChange,
  disabled,
}: {
  value: ContextualRetrievalMode;
  onChange: (value: ContextualRetrievalMode) => void;
  disabled: boolean;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => onChange(next as ContextualRetrievalMode)}
      disabled={disabled}
    >
      <SelectTrigger
        className="w-full max-w-xs"
        aria-label="Context generation"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="disabled">Disabled</SelectItem>
        <SelectItem value="document">Per document — lower cost</SelectItem>
        <SelectItem value="chunk">Per passage — higher recall</SelectItem>
      </SelectContent>
    </Select>
  );
}

function TestConnectionIcon({ status }: { status: ConnectionStatus }) {
  if (status === "testing") {
    return <Loader2 className="mr-1 size-3.5 animate-spin" />;
  }
  if (status === "connected") {
    return (
      <CheckCircle2 className="mr-1 size-3.5 text-green-600 dark:text-green-400" />
    );
  }
  return <Zap className="mr-1 size-3.5" />;
}

export function KeywordRankingDescription() {
  return (
    <>
      Scores each passage by the words it shares with the question, using BM25 —
      rare, specific words count most. Always on.{" "}
      <ExternalDocsLink
        href={getDocsUrl(DocsPage.PlatformKnowledge, "keyword-ranking")}
        className="text-primary hover:underline"
        showIcon={false}
      >
        Learn more.
      </ExternalDocsLink>
    </>
  );
}

export function EmbeddingConfigurationDescription() {
  return (
    <>
      The model that turns your documents into searchable meaning. It decides
      how well a search finds passages that say what was asked in different
      words. Pick it once — changing it later means re-indexing everything. A
      key appears here once its embedding models are synced with dimensions set
      (384, 768, 1024, 1536 or 3072).
    </>
  );
}

export function EmbeddingConfigurationCardHeader() {
  return (
    <CardHeader>
      <CardTitle>Embedding Configuration</CardTitle>
      <CardDescription className="leading-relaxed">
        <EmbeddingConfigurationDescription />
      </CardDescription>
    </CardHeader>
  );
}

export function EmbeddingConfigurationSectionHeader() {
  return (
    <KnowledgeConfigurationSectionHeader title="Embedding Configuration" />
  );
}

export function SearchRankingConfigurationDescription() {
  return (
    <>
      Orders the passages a search has found. Keyword ranking scores them by the
      words they share with the question and builds the shortlist; reranking
      reads that shortlist and puts the passages that answer the question first.
      Changes apply to the next search — nothing is re-indexed.
    </>
  );
}

export function SearchRankingConfigurationCardHeader() {
  return (
    <CardHeader>
      <CardTitle>Search Ranking Configuration</CardTitle>
      <CardDescription>
        <SearchRankingConfigurationDescription />
      </CardDescription>
    </CardHeader>
  );
}

export function SearchRankingConfigurationSectionHeader() {
  return (
    <KnowledgeConfigurationSectionHeader title="Search Ranking Configuration" />
  );
}

export function KeywordRankingSectionHeader({
  status,
  showDescription = true,
}: {
  status?: ReactNode;
  showDescription?: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <h4 className="text-sm font-medium">Keyword ranking</h4>
        {status}
      </div>
      {showDescription && (
        <p className="text-sm text-muted-foreground">
          <KeywordRankingDescription />
        </p>
      )}
    </div>
  );
}

export function RerankingDescription() {
  return (
    <>
      Reads the shortlisted passages with a model and puts the ones that answer
      the question first. Works with any chat model or a dedicated rerank model
      served through a supported native rerank API. Optional.{" "}
      <ExternalDocsLink
        href={getDocsUrl(DocsPage.PlatformKnowledge, "reranking")}
        className="text-primary hover:underline"
        showIcon={false}
      >
        Learn more.
      </ExternalDocsLink>
    </>
  );
}

export function RerankingSectionHeader({
  showDescription = true,
}: {
  showDescription?: boolean;
}) {
  return (
    <div className="space-y-1">
      <h4 className="text-sm font-medium">Reranking</h4>
      {showDescription && (
        <p className="text-sm text-muted-foreground">
          <RerankingDescription />
        </p>
      )}
    </div>
  );
}

export function ContextualRetrievalDescription() {
  return (
    <>
      Adds search-only context to passages during ingestion. The document option
      makes one model call per document. The passage option generates specific
      context in batches for longer documents and uses the document option for
      short ones. Requires a chat reranking model.{" "}
      <ExternalDocsLink
        href={getDocsUrl(DocsPage.PlatformKnowledge, "contextual-retrieval")}
        className="text-primary hover:underline"
        showIcon={false}
      >
        Learn more.
      </ExternalDocsLink>
    </>
  );
}

export function ContextualRetrievalSectionHeader({
  showDescription = true,
}: {
  showDescription?: boolean;
}) {
  return (
    <div className="space-y-1">
      <h4 className="text-sm font-medium">Contextual retrieval</h4>
      {showDescription && (
        <p className="text-sm text-muted-foreground">
          <ContextualRetrievalDescription />
        </p>
      )}
    </div>
  );
}

export function DocumentOcrDescription() {
  return (
    <>
      Reads the text in scanned or image-only PDF pages — a signed contract that
      was scanned, for example — so those documents show up in search like any
      other. Without it, such pages are skipped. Each transcribed page is one
      metered model call, visible in LLM cost statistics. Optional.
    </>
  );
}

export function DocumentOcrCardHeader() {
  return (
    <CardHeader>
      <CardTitle>Document OCR</CardTitle>
      <CardDescription>
        <DocumentOcrDescription />
      </CardDescription>
    </CardHeader>
  );
}

export function DocumentOcrSectionHeader() {
  return <KnowledgeConfigurationSectionHeader title="Document OCR" />;
}

function KnowledgeConfigurationSectionHeader({ title }: { title: string }) {
  return <h3 className="font-semibold">{title}</h3>;
}

export function EmbeddingModelHelp() {
  return (
    <p className="text-sm text-muted-foreground sm:pl-44">
      Don&apos;t see your model?{" "}
      <Link
        href="/llm/models"
        className="inline-flex items-center gap-0.5 text-primary underline-offset-2 hover:underline"
      >
        Sync models and configure embedding dimensions
        <ArrowUpRight className="h-3.5 w-3.5" />
      </Link>
    </p>
  );
}

export function OcrModelHelp() {
  return (
    <p className="text-sm text-muted-foreground sm:pl-44">
      Don&apos;t see your model?{" "}
      <Link
        href="/llm/models"
        className="inline-flex items-center gap-0.5 text-primary underline-offset-2 hover:underline"
      >
        Mark its image or PDF input modality
        <ArrowUpRight className="h-3.5 w-3.5" />
      </Link>
    </p>
  );
}

export function KnowledgeBm25Fields({
  bm25K1,
  bm25B,
  onBm25K1Change,
  onBm25BChange,
  onBm25K1Blur,
  onBm25BBlur,
  disabled = false,
  idPrefix = "bm25",
  bm25K1Invalid,
  bm25BInvalid,
}: {
  bm25K1: string;
  bm25B: string;
  onBm25K1Change: (value: string) => void;
  onBm25BChange: (value: string) => void;
  onBm25K1Blur?: () => void;
  onBm25BBlur?: () => void;
  disabled?: boolean;
  idPrefix?: string;
  bm25K1Invalid?: boolean;
  bm25BInvalid?: boolean;
}) {
  const parsedK1 = Number(bm25K1);
  const parsedB = Number(bm25B);
  const k1Invalid =
    bm25K1Invalid ??
    (bm25K1.trim() === "" ||
      !Number.isFinite(parsedK1) ||
      parsedK1 < BM25_K1_MIN ||
      parsedK1 > BM25_K1_MAX);
  const bInvalid =
    bm25BInvalid ??
    (bm25B.trim() === "" ||
      !Number.isFinite(parsedB) ||
      parsedB < BM25_B_MIN ||
      parsedB > BM25_B_MAX);

  return (
    <div className="flex flex-col gap-4">
      <KnowledgeSettingsRow label="Term Saturation">
        <Input
          type="number"
          inputMode="decimal"
          step="0.1"
          min={BM25_K1_MIN}
          max={BM25_K1_MAX}
          value={bm25K1}
          disabled={disabled}
          aria-invalid={k1Invalid}
          aria-label="Term Saturation"
          aria-describedby={k1Invalid ? `${idPrefix}-k1-error` : undefined}
          onChange={(event) => onBm25K1Change(event.target.value)}
          onBlur={onBm25K1Blur}
          className="max-w-xs"
        />
        {k1Invalid && (
          <p
            id={`${idPrefix}-k1-error`}
            className="mt-1 text-xs text-destructive"
          >
            Enter a value between {BM25_K1_MIN} and {BM25_K1_MAX}.
          </p>
        )}
      </KnowledgeSettingsRow>
      <KnowledgeSettingsRow label="Length Normalization">
        <Input
          type="number"
          inputMode="decimal"
          step="0.05"
          min={BM25_B_MIN}
          max={BM25_B_MAX}
          value={bm25B}
          disabled={disabled}
          aria-invalid={bInvalid}
          aria-label="Length Normalization"
          aria-describedby={bInvalid ? `${idPrefix}-b-error` : undefined}
          onChange={(event) => onBm25BChange(event.target.value)}
          onBlur={onBm25BBlur}
          className="max-w-xs"
        />
        {bInvalid && (
          <p
            id={`${idPrefix}-b-error`}
            className="mt-1 text-xs text-destructive"
          >
            Enter a value between {BM25_B_MIN} and {BM25_B_MAX}.
          </p>
        )}
      </KnowledgeSettingsRow>
    </div>
  );
}
