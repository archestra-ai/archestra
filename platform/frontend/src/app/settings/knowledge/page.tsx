// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

"use client";

import {
  type archestraApiTypes,
  BM25_B_DEFAULT,
  BM25_B_MAX,
  BM25_B_MIN,
  BM25_K1_DEFAULT,
  BM25_K1_MAX,
  BM25_K1_MIN,
  CONNECTOR_TYPE_LABELS,
  type ConnectorType,
  type ContextualRetrievalMode,
  isProviderApiKeyOptional,
} from "@archestra/shared";
import { formatDistanceToNow } from "date-fns";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Info,
  Loader2,
  Lock,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import {
  EmbeddingModelImageSupportNotice,
  embeddingModelSupportsImages,
} from "@/app/knowledge/_parts/embedding-model-image-support-notice";
import { ConnectorTypeIcon } from "@/app/knowledge/knowledge-bases/_parts/connector-icons";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import {
  LLM_PROVIDER_API_KEY_PLACEHOLDER,
  LlmProviderApiKeyForm,
  type LlmProviderApiKeyFormValues,
} from "@/components/llm-provider-api-key-form";
import { LoadingState, LoadingWrapper } from "@/components/loading";
import { QueryLoadError } from "@/components/query-load-error";
import { WithPermissions } from "@/components/roles/with-permissions";
import { IntegrationAvailabilitySection } from "@/components/settings/integration-availability-section";
import {
  SettingsBlock,
  SettingsSaveBar,
  SettingsSectionStack,
} from "@/components/settings/settings-block";
import { SmallTeamTierBanner } from "@/components/small-team-tier-banner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { useSession } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import {
  useEmbeddingModels,
  useModelsWithApiKeys,
} from "@/lib/llm-models.query";
import {
  useAvailableLlmProviderApiKeys,
  useCreateLlmProviderApiKey,
} from "@/lib/llm-provider-api-keys.query";
import {
  useDropEmbeddingConfig,
  useKeywordRankingStatus,
  useOrganization,
  useTestEmbeddingConnection,
  useTestOcrConnection,
  useTestRerankerConnection,
  useUpdateKnowledgeSettings,
} from "@/lib/organization.query";
import { cn } from "@/lib/utils";
import {
  KnowledgeConfigurationFields,
  KnowledgeConnectionActions,
} from "./knowledge-settings-fields";
import { type SectionStatus, saveResultStatuses } from "./knowledge-validation";
import { RetrievalEvaluationSection } from "./retrieval-evaluation-section";

const DEFAULT_FORM_VALUES: LlmProviderApiKeyFormValues = {
  name: "",
  provider: "openai",
  apiKey: null,
  baseUrl: null,
  inferenceBaseUrl: null,
  extraHeaders: [],
  scope: "org",
  teamId: null,
  vaultSecretPath: null,
  vaultSecretKey: null,
  isPrimary: true,
  bedrockAuthMethod: "api-key",
  awsAccessKeyId: null,
  awsSecretAccessKey: null,
  awsSessionToken: null,
  authMethod: "api-key",
};

const EMBEDDING_DEFAULT_FORM_VALUES: LlmProviderApiKeyFormValues = {
  ...DEFAULT_FORM_VALUES,
};
/** A BM25 factor input's text as a number; empty is "no value" (the default). */
function parseFactor(text: string): number | null {
  return text.trim() === "" ? null : Number(text);
}

function AddApiKeyDialog({
  open,
  onOpenChange,
  forEmbedding = false,
  forOcr = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  forEmbedding?: boolean;
  forOcr?: boolean;
}) {
  const createMutation = useCreateLlmProviderApiKey();
  const byosEnabled = useFeature("byosEnabled");
  const azureOpenAiEntraIdEnabled = useFeature("azureOpenAiEntraIdEnabled");
  const anthropicWifEnabled = useFeature("anthropicWifEnabled");
  const bedrockIamAuthEnabled = useFeature("bedrockIamAuthEnabled");
  const geminiVertexAiEnabled = useFeature("geminiVertexAiEnabled");

  const defaults = forEmbedding
    ? EMBEDDING_DEFAULT_FORM_VALUES
    : DEFAULT_FORM_VALUES;

  const form = useForm<LlmProviderApiKeyFormValues>({
    defaultValues: defaults,
  });

  useEffect(() => {
    if (open) {
      form.reset(defaults);
    }
  }, [open, form, defaults]);

  const formValues = form.watch();
  const isValid =
    formValues.apiKey !== LLM_PROVIDER_API_KEY_PLACEHOLDER &&
    formValues.name &&
    (formValues.scope !== "team" || formValues.teamId) &&
    (byosEnabled
      ? formValues.vaultSecretPath && formValues.vaultSecretKey
      : isProviderApiKeyOptional({
          provider: formValues.provider,
          azureEntraIdEnabled: azureOpenAiEntraIdEnabled === true,
          anthropicWifEnabled: anthropicWifEnabled === true,
        }) || formValues.apiKey);

  const handleCreate = form.handleSubmit(async (values) => {
    const isBedrockSigV4 =
      values.provider === "bedrock" && values.bedrockAuthMethod === "sigv4";
    try {
      await createMutation.mutateAsync({
        name: values.name,
        provider: values.provider,
        apiKey: isBedrockSigV4 ? undefined : values.apiKey || undefined,
        baseUrl: values.baseUrl || undefined,
        inferenceBaseUrl: values.inferenceBaseUrl || undefined,
        scope: values.scope,
        teamId:
          values.scope === "team" && values.teamId ? values.teamId : undefined,
        isPrimary: values.isPrimary,
        vaultSecretPath:
          !isBedrockSigV4 && byosEnabled && values.vaultSecretPath
            ? values.vaultSecretPath
            : undefined,
        vaultSecretKey:
          !isBedrockSigV4 && byosEnabled && values.vaultSecretKey
            ? values.vaultSecretKey
            : undefined,
        awsAccessKeyId: isBedrockSigV4
          ? values.awsAccessKeyId || undefined
          : undefined,
        awsSecretAccessKey: isBedrockSigV4
          ? values.awsSecretAccessKey || undefined
          : undefined,
        awsSessionToken: isBedrockSigV4
          ? values.awsSessionToken || undefined
          : undefined,
      });
      onOpenChange(false);
    } catch {
      // Error handled by mutation
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add LLM Provider Key"
      description={
        forEmbedding
          ? "Add an API key for knowledge base embeddings."
          : forOcr
            ? "Add an API key for document OCR."
            : "Add an LLM provider API key for knowledge base reranking."
      }
      size="small"
    >
      <DialogForm
        onSubmit={handleCreate}
        className="flex min-h-0 flex-1 flex-col"
      >
        <DialogBody className="space-y-4">
          <LlmProviderApiKeyForm
            mode="full"
            showConsoleLink={false}
            form={form}
            isPending={createMutation.isPending}
            bedrockIamAuthEnabled={bedrockIamAuthEnabled}
            geminiVertexAiEnabled={geminiVertexAiEnabled}
            hideScopeAndPrimary
            forEmbedding={forEmbedding}
            allowPersonalSubscriptions={false}
          />
        </DialogBody>
        <DialogStickyFooter className="mt-0">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={!isValid || createMutation.isPending}>
            {createMutation.isPending && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            <span>Test & Create</span>
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}

/**
 * Determine which setup step needs attention for a section.
 * Returns the step that should pulse, or null if setup is complete.
 */
function useSetupStep({
  selectedKeyId,
  selectedModel,
  hasSelectableKeys,
}: {
  selectedKeyId: string | null;
  selectedModel: string | null;
  hasSelectableKeys: boolean;
}): "add-key" | "select-key" | "select-model" | null {
  if (!hasSelectableKeys) return "add-key";
  if (!selectedKeyId) return "select-key";
  if (!selectedModel) return "select-model";
  return null;
}

function DropEmbeddingConfigDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const dropMutation = useDropEmbeddingConfig();

  const handleDrop = async () => {
    await dropMutation.mutateAsync();
    onOpenChange(false);
  };

  return (
    <DeleteConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Drop embedding configuration?"
      description="This deletes all embedded documents. Connectors and knowledge bases are preserved — the next sync will re-ingest everything with the new embedding model."
      isPending={dropMutation.isPending}
      onConfirm={handleDrop}
      confirmLabel="Drop"
      pendingLabel="Dropping..."
    />
  );
}

/**
 * Where BM25 keyword ranking stands, compact enough to sit right-aligned on
 * the "Keyword ranking" heading line. BM25 scores from corpus statistics
 * rebuilt in the background, so until the first build — or for documents
 * first indexed since the last one — keyword search ranks with PostgreSQL's
 * built-in ranking. This answers "is it ready, and if not, when?"; the
 * consequence lives in the title tooltip so the line stays one glanceable
 * phrase.
 */
function KeywordRankingStatusLine({
  status,
}: {
  status: archestraApiTypes.GetKeywordRankingStatusResponses["200"];
}) {
  const line = (
    icon: React.ReactNode,
    text: React.ReactNode,
    options?: { title?: string; tone?: "muted" | "destructive" },
  ) => (
    // <output> is the semantic live region: announced when the poll moves the
    // state on, rather than changing silently under a screen reader mid-page.
    <output
      className={cn(
        "flex items-center gap-1.5 text-xs",
        options?.tone === "destructive"
          ? "text-destructive"
          : "text-muted-foreground",
      )}
      title={options?.title}
    >
      {icon}
      <span>{text}</span>
    </output>
  );

  if (status.refreshing) {
    return line(
      <Loader2 className="size-3.5 shrink-0 animate-spin" />,
      <span>Updating statistics…</span>,
    );
  }
  // Before the failure branch: a rebuild covers the whole deployment, so an
  // organization with nothing indexed would otherwise be shown a failure that
  // has nothing to do with it.
  if (status.status === "no_documents") {
    return line(
      <Info className="size-3.5 shrink-0" />,
      <span>No documents indexed yet</span>,
      {
        title:
          "Ranking statistics build after the first sync indexes documents.",
      },
    );
  }
  if (status.lastRefreshFailed) {
    return line(
      <AlertCircle className="size-3.5 shrink-0" />,
      <span>
        <span>Statistics update failed</span>
        {status.nextRefreshAt ? (
          <span> · retrying {inFromNow(status.nextRefreshAt)}</span>
        ) : null}
      </span>,
      {
        tone: "destructive",
        title:
          "The last rebuild of the ranking statistics did not finish. Searches keep using the statistics from the last successful one; the server logs carry the error.",
      },
    );
  }
  if (status.status === "pending") {
    return line(
      <Clock className="size-3.5 shrink-0 text-amber-600 dark:text-amber-500" />,
      <span>
        <span>Building statistics</span>
        {status.nextRefreshAt ? (
          <span> · ready {inFromNow(status.nextRefreshAt)}</span>
        ) : null}
      </span>,
      {
        title:
          "Documents indexed since the last statistics update rank with PostgreSQL's built-in ranking until the next one.",
      },
    );
  }
  return line(
    <CheckCircle2 className="size-3.5 shrink-0 text-green-600 dark:text-green-400" />,
    <span>
      <span>Ready</span>
      {status.lastRefreshedAt ? (
        <span>
          {" "}
          · statistics refreshed{" "}
          {formatDistanceToNow(new Date(status.lastRefreshedAt), {
            addSuffix: true,
          })}
        </span>
      ) : null}
    </span>,
  );
}

/**
 * "in 40 minutes" for a future time, "shortly" for one already past.
 *
 * The timestamp says when the rebuild is DUE, and a backed-up queue can leave
 * it behind. date-fns renders anything not strictly in the future with an
 * "ago" suffix — including a timestamp clamped to the present — so a late
 * rebuild would read "ready less than a minute ago", the opposite of what the
 * line means.
 */
function inFromNow(timestamp: string): string {
  const due = new Date(timestamp);
  if (due.getTime() <= Date.now()) return "shortly";
  return formatDistanceToNow(due, { addSuffix: true });
}

function KnowledgeSettingsContent() {
  const { data: organization, isPending } = useOrganization();
  const { data: session } = useSession();
  const {
    data: apiKeys,
    isPending: areApiKeysPending,
    isLoadingError: isApiKeysLoadError,
    refetch: refetchApiKeys,
  } = useAvailableLlmProviderApiKeys({ toastOnError: false });
  const updateKnowledgeSettings = useUpdateKnowledgeSettings(
    "Knowledge settings updated",
    "Failed to update knowledge settings",
  );
  const testConnection = useTestEmbeddingConnection();
  const { data: keywordRankingStatus } = useKeywordRankingStatus();
  const testRerankerConnection = useTestRerankerConnection();
  const testOcrConnection = useTestOcrConnection();
  const [showDropDialog, setShowDropDialog] = useState(false);

  // Per-section connection status (the pill + inline reason on each card).
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

  const [embeddingModel, setEmbeddingModel] = useState<string | null>(null);
  const [embeddingChatApiKeyId, setEmbeddingChatApiKeyId] = useState<
    string | null
  >(null);
  const [rerankerChatApiKeyId, setRerankerChatApiKeyId] = useState<
    string | null
  >(null);
  const [rerankerModel, setRerankerModel] = useState<string | null>(null);
  const [ocrChatApiKeyId, setOcrChatApiKeyId] = useState<string | null>(null);
  const [ocrModel, setOcrModel] = useState<string | null>(null);
  const [contextualRetrievalMode, setContextualRetrievalMode] =
    useState<ContextualRetrievalMode | null>(null);
  const [evaluationAddKeyPurpose, setEvaluationAddKeyPurpose] = useState<
    "embedding" | "reranking" | "ocr" | null
  >(null);
  // BM25 factors, as the text the inputs show. The deployment default is shown
  // as a value like any other; a value equal to it is saved as "inherit"
  // (null), so an organization that never strays from the default follows it
  // if it changes.
  // null = the admin has not touched the field, so it shows whatever is in
  // effect (the organization's override, else the deployment default). Keeping
  // "untouched" distinct from a typed value is what stops a late-arriving
  // config or organization refetch from overwriting an edit in progress, and
  // what makes an emptied field fall back to the SAVED value rather than
  // silently proposing to clear the override.
  const [bm25K1Text, setBm25K1Text] = useState<string | null>(null);
  const [bm25BText, setBm25BText] = useState<string | null>(null);
  const kbBm25DefaultK1 = useFeature("kbBm25DefaultK1");
  const kbBm25DefaultB = useFeature("kbBm25DefaultB");
  const kbContextualRetrievalDefaultMode = useFeature(
    "kbContextualRetrievalDefaultMode",
  );
  const knowledgeEvaluationBetaEnabled =
    useFeature("knowledgeEvaluationBetaEnabled") === true;
  const bm25DefaultK1 =
    typeof kbBm25DefaultK1 === "number" ? kbBm25DefaultK1 : BM25_K1_DEFAULT;
  const bm25DefaultB =
    typeof kbBm25DefaultB === "number" ? kbBm25DefaultB : BM25_B_DEFAULT;
  const contextualRetrievalDefaultMode =
    typeof kbContextualRetrievalDefaultMode === "string"
      ? kbContextualRetrievalDefaultMode
      : "disabled";

  const { data: embeddingModels } = useEmbeddingModels(embeddingChatApiKeyId);
  const {
    data: modelsWithApiKeys,
    isLoadingError: isModelsWithApiKeysLoadError,
    refetch: refetchModelsWithApiKeys,
  } = useModelsWithApiKeys({ toastOnError: false });
  const selectedEmbeddingApiKey = useMemo(
    () =>
      apiKeys?.find((apiKey) => apiKey.id === embeddingChatApiKeyId) ?? null,
    [apiKeys, embeddingChatApiKeyId],
  );
  const selectedEmbeddingModel = useMemo(
    () => embeddingModels?.find((model) => model.id === embeddingModel) ?? null,
    [embeddingModels, embeddingModel],
  );
  const selectedEmbeddingCatalogModel =
    modelsWithApiKeys?.find(
      (model) =>
        model.modelId === embeddingModel &&
        model.apiKeys.some((apiKey) => apiKey.id === embeddingChatApiKeyId),
    ) ?? null;
  const selectedEmbeddingProvider =
    selectedEmbeddingApiKey?.provider ??
    selectedEmbeddingModel?.provider ??
    null;
  const noticeDismissalScope =
    organization?.id && session?.user.id
      ? `${organization.id}:${session.user.id}`
      : null;

  useEffect(() => {
    if (organization) {
      // Only set embedding model if user has explicitly configured a key
      // (otherwise the database default is not a user choice)
      const hasEmbeddingKey = !!organization.embeddingChatApiKeyId;
      setEmbeddingModel(
        hasEmbeddingKey ? (organization.embeddingModel ?? null) : null,
      );
      setEmbeddingChatApiKeyId(organization.embeddingChatApiKeyId ?? null);
      setRerankerChatApiKeyId(organization.rerankerChatApiKeyId ?? null);
      setRerankerModel(organization.rerankerModel ?? null);
      setOcrChatApiKeyId(organization.ocrChatApiKeyId ?? null);
      setOcrModel(organization.ocrModel ?? null);
      setContextualRetrievalMode(
        organization.kbContextualRetrievalMode ??
          contextualRetrievalDefaultMode,
      );
    }
  }, [organization, contextualRetrievalDefaultMode]);

  // The factors are re-seeded only when the SAVED values move, not on every
  // organization object. Other sections of this page (Available connectors,
  // for one) write the organization into the query cache when they save, and
  // keying this on the object identity would drop whatever the admin had
  // typed here in the meantime.
  const savedBm25K1 = organization?.kbBm25K1 ?? null;
  const savedBm25B = organization?.kbBm25B ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the saved values are the trigger, not a read
  useEffect(() => {
    setBm25K1Text(null);
    setBm25BText(null);
  }, [savedBm25K1, savedBm25B]);

  // Changing a section's key/model invalidates its last connection result.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on config change only
  useEffect(() => {
    setEmbeddingStatus({ status: "untested", error: null });
  }, [embeddingChatApiKeyId, embeddingModel]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on config change only
  useEffect(() => {
    setRerankerStatus({ status: "untested", error: null });
  }, [rerankerChatApiKeyId, rerankerModel]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on config change only
  useEffect(() => {
    setOcrStatus({ status: "untested", error: null });
  }, [ocrChatApiKeyId, ocrModel]);

  // A stable signature of each section's current config. An in-flight test or
  // save captures the signature it ran against and only applies its result if
  // the signature still matches — so a result that resolves after the user
  // changed the key/model (or cleared it) isn't attributed to the new config.
  const embeddingConfigSig = `${embeddingChatApiKeyId ?? ""}|${embeddingModel ?? ""}`;
  const rerankerConfigSig = `${rerankerChatApiKeyId ?? ""}|${rerankerModel ?? ""}`;
  const ocrConfigSig = `${ocrChatApiKeyId ?? ""}|${ocrModel ?? ""}`;
  const embeddingConfigSigRef = useRef(embeddingConfigSig);
  const rerankerConfigSigRef = useRef(rerankerConfigSig);
  const ocrConfigSigRef = useRef(ocrConfigSig);
  // Sync the refs during render (not in an effect): the value is derived purely
  // from committed state, so writing it here keeps the ref in lock-step with the
  // current config. An effect would lag by a commit, leaving a window where an
  // in-flight test/save resolves against a stale signature and applies its result
  // to the just-changed config.
  embeddingConfigSigRef.current = embeddingConfigSig;
  rerankerConfigSigRef.current = rerankerConfigSig;
  ocrConfigSigRef.current = ocrConfigSig;

  const serverEmbeddingKeyId = organization?.embeddingChatApiKeyId ?? null;
  const serverEmbeddingModel = serverEmbeddingKeyId
    ? (organization?.embeddingModel ?? null)
    : null;
  const serverRerankerKeyId = organization?.rerankerChatApiKeyId ?? null;
  const serverRerankerModel = organization?.rerankerModel ?? null;
  const serverOcrKeyId = organization?.ocrChatApiKeyId ?? null;
  const serverOcrModel = organization?.ocrModel ?? null;
  const serverBm25K1 = organization?.kbBm25K1 ?? bm25DefaultK1;
  const serverBm25B = organization?.kbBm25B ?? bm25DefaultB;
  const serverContextualRetrievalMode =
    organization?.kbContextualRetrievalMode ?? contextualRetrievalDefaultMode;
  const effectiveContextualRetrievalMode =
    contextualRetrievalMode ?? serverContextualRetrievalMode;
  // What the inputs show: the edit if there is one, else what is in effect.
  const bm25K1Value = bm25K1Text ?? String(serverBm25K1);
  const bm25BValue = bm25BText ?? String(serverBm25B);
  // An empty field is an editing state, not an instruction: it keeps meaning
  // the saved value until something parseable is typed.
  const bm25K1 = parseFactor(bm25K1Value) ?? serverBm25K1;
  const bm25B = parseFactor(bm25BValue) ?? serverBm25B;

  const hasChanges =
    embeddingModel !== serverEmbeddingModel ||
    embeddingChatApiKeyId !== serverEmbeddingKeyId ||
    rerankerChatApiKeyId !== serverRerankerKeyId ||
    rerankerModel !== serverRerankerModel ||
    ocrChatApiKeyId !== serverOcrKeyId ||
    ocrModel !== serverOcrModel ||
    effectiveContextualRetrievalMode !== serverContextualRetrievalMode ||
    bm25K1 !== serverBm25K1 ||
    bm25B !== serverBm25B;

  // Out-of-range tuning is rejected by the API; hold the save until it is
  // fixed rather than round-tripping to a 400.
  const bm25K1Invalid =
    !Number.isFinite(bm25K1) || bm25K1 < BM25_K1_MIN || bm25K1 > BM25_K1_MAX;
  const bm25BInvalid =
    !Number.isFinite(bm25B) || bm25B < BM25_B_MIN || bm25B > BM25_B_MAX;

  // Embedding model is locked once both key and model have been saved
  const isEmbeddingModelLocked =
    !!serverEmbeddingKeyId && !!serverEmbeddingModel;
  const embeddingConfigured = !!embeddingChatApiKeyId && !!embeddingModel;
  const rerankerConfigured = !!rerankerChatApiKeyId && !!rerankerModel;
  const ocrConfigured = !!ocrChatApiKeyId && !!ocrModel;
  const ocrWasEnabled = !!serverOcrKeyId && !!serverOcrModel;
  // A section's connection can be tested whenever it is fully configured —
  // including a locked embedding, to confirm it still works.
  const showEmbeddingFooter = isEmbeddingModelLocked || embeddingConfigured;

  // Check if keys exist for pulsing logic
  const hasApiKeys = useMemo(() => (apiKeys ?? []).length > 0, [apiKeys]);
  const isInitialLoading = isPending || areApiKeysPending;

  const embeddingSetupStep = useSetupStep({
    selectedKeyId: embeddingChatApiKeyId,
    selectedModel: embeddingModel,
    hasSelectableKeys: isInitialLoading ? true : hasApiKeys,
  });

  const rerankerSetupStep = useSetupStep({
    selectedKeyId: rerankerChatApiKeyId,
    selectedModel: rerankerModel,
    hasSelectableKeys: isInitialLoading ? true : hasApiKeys,
  });

  const handleTestEmbedding = async () => {
    if (!embeddingChatApiKeyId || !embeddingModel) return;
    const sig = embeddingConfigSig;
    setEmbeddingStatus({ status: "testing", error: null });
    let next: SectionStatus;
    try {
      const result = await testConnection.mutateAsync({
        embeddingChatApiKeyId,
        embeddingModel,
      });
      next = result.success
        ? { status: "connected", error: null }
        : { status: "failed", error: result.error ?? "Connection failed." };
    } catch {
      next = { status: "failed", error: "Connection test failed." };
    }
    // Drop the result if the config changed while the test was in flight.
    if (embeddingConfigSigRef.current !== sig) return;
    setEmbeddingStatus(next);
  };

  const handleTestReranker = async () => {
    if (!rerankerChatApiKeyId || !rerankerModel) return;
    const sig = rerankerConfigSig;
    setRerankerStatus({ status: "testing", error: null });
    let next: SectionStatus;
    try {
      const result = await testRerankerConnection.mutateAsync({
        rerankerChatApiKeyId,
        rerankerModel,
      });
      next = result.success
        ? { status: "connected", error: null }
        : { status: "failed", error: result.error ?? "Connection failed." };
    } catch {
      next = { status: "failed", error: "Connection test failed." };
    }
    if (rerankerConfigSigRef.current !== sig) return;
    setRerankerStatus(next);
  };

  const handleTestOcr = async () => {
    if (!ocrChatApiKeyId || !ocrModel) return;
    const sig = ocrConfigSig;
    setOcrStatus({ status: "testing", error: null });
    let next: SectionStatus;
    try {
      const result = await testOcrConnection.mutateAsync({
        ocrChatApiKeyId,
        ocrModel,
      });
      next = result.success
        ? { status: "connected", error: null }
        : { status: "failed", error: result.error ?? "Connection failed." };
    } catch {
      next = { status: "failed", error: "Connection test failed." };
    }
    if (ocrConfigSigRef.current !== sig) return;
    setOcrStatus(next);
  };

  const handleSave = async () => {
    // Snapshot what we're validating so a save that resolves after the user
    // edited a section doesn't stamp its result onto the changed config.
    const embeddingSig = embeddingConfigSig;
    const rerankerSig = rerankerConfigSig;
    const ocrSig = ocrConfigSig;
    const savedEmbeddingConfigured = embeddingConfigured;
    const savedRerankerConfigured = rerankerConfigured;
    const savedOcrConfigured = ocrConfigured;
    // Drive each configured section's pill through the save; the checks run
    // server-side and resolve to connected / failed (with the reason) per field.
    if (savedEmbeddingConfigured) {
      setEmbeddingStatus({ status: "testing", error: null });
    }
    if (savedRerankerConfigured) {
      setRerankerStatus({ status: "testing", error: null });
    }
    if (savedOcrConfigured) {
      setOcrStatus({ status: "testing", error: null });
    }
    let saveError: unknown = null;
    try {
      // Only the sections that actually changed. The backend re-validates a
      // section by exercising it — a real embedding call, a real reranker
      // call, a real OCR page — whenever the payload mentions it, so sending
      // every field on every save bills three model calls for a factor edit
      // and lets a section the admin never touched (an expired reranker key,
      // say) fail the save.
      const embeddingChanged =
        embeddingModel !== serverEmbeddingModel ||
        embeddingChatApiKeyId !== serverEmbeddingKeyId;
      const rerankerChanged =
        rerankerChatApiKeyId !== serverRerankerKeyId ||
        rerankerModel !== serverRerankerModel;
      const ocrChanged =
        ocrChatApiKeyId !== serverOcrKeyId || ocrModel !== serverOcrModel;
      await updateKnowledgeSettings.mutateAsync({
        ...(embeddingChanged && {
          embeddingModel: embeddingModel ?? undefined,
          embeddingChatApiKeyId: embeddingChatApiKeyId ?? null,
        }),
        ...(rerankerChanged && {
          rerankerChatApiKeyId: rerankerChatApiKeyId ?? null,
          rerankerModel: rerankerModel ?? null,
        }),
        ...(ocrChanged && {
          ocrChatApiKeyId: ocrChatApiKeyId ?? null,
          ocrModel: ocrModel ?? null,
        }),
        ...(effectiveContextualRetrievalMode !==
          serverContextualRetrievalMode && {
          kbContextualRetrievalMode: effectiveContextualRetrievalMode,
        }),
        kbBm25K1: bm25K1 === bm25DefaultK1 ? null : bm25K1,
        kbBm25B: bm25B === bm25DefaultB ? null : bm25B,
      });
    } catch (error) {
      saveError = error;
    }
    const next = saveResultStatuses({
      error: saveError,
      embeddingConfigured: savedEmbeddingConfigured,
      rerankerConfigured: savedRerankerConfigured,
      ocrConfigured: savedOcrConfigured,
    });
    if (embeddingConfigSigRef.current === embeddingSig) {
      setEmbeddingStatus(next.embedding);
    }
    if (rerankerConfigSigRef.current === rerankerSig) {
      setRerankerStatus(next.reranker);
    }
    if (ocrConfigSigRef.current === ocrSig) {
      setOcrStatus(next.ocr);
    }
  };

  const handleCancel = () => {
    setEmbeddingModel(serverEmbeddingModel);
    setEmbeddingChatApiKeyId(serverEmbeddingKeyId);
    setRerankerChatApiKeyId(serverRerankerKeyId);
    setRerankerModel(serverRerankerModel);
    setOcrChatApiKeyId(serverOcrKeyId);
    setOcrModel(serverOcrModel);
    setContextualRetrievalMode(serverContextualRetrievalMode);
    setBm25K1Text(null);
    setBm25BText(null);
  };

  const isLoadError = isApiKeysLoadError || isModelsWithApiKeysLoadError;

  if (!isInitialLoading && isLoadError) {
    return (
      <QueryLoadError
        title="Couldn't load your knowledge settings"
        onRetry={() => {
          refetchApiKeys();
          refetchModelsWithApiKeys();
        }}
      />
    );
  }

  return (
    <LoadingWrapper
      isPending={isInitialLoading}
      loadingFallback={<LoadingState variant="page" />}
    >
      <SettingsSectionStack>
        <SettingsBlock
          id="embedding-configuration"
          title="Embedding Configuration"
          description={
            <>
              The model that turns your documents into searchable meaning. It
              decides how well a search finds passages that say what was asked
              in different words. Pick it once — changing it later means
              re-indexing everything. A key appears here once its embedding
              models are synced with dimensions set (384, 768, 1024, 1536 or
              3072).
            </>
          }
        >
          <WithPermissions
            permissions={{ knowledgeSettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <KnowledgeConfigurationFields
                sections={["embedding"]}
                showTopLevelHeadings={false}
                embedding={{
                  chatApiKeyId: embeddingChatApiKeyId,
                  model: embeddingModel,
                }}
                onEmbeddingChange={(value) => {
                  setEmbeddingChatApiKeyId(value.chatApiKeyId);
                  setEmbeddingModel(value.model);
                }}
                reranker={{
                  chatApiKeyId: rerankerChatApiKeyId,
                  model: rerankerModel,
                }}
                onRerankerChange={() => {}}
                ocr={{ chatApiKeyId: ocrChatApiKeyId, model: ocrModel }}
                onOcrChange={() => {}}
                bm25K1={bm25K1Value}
                bm25B={bm25BValue}
                onBm25K1Change={() => {}}
                onBm25BChange={() => {}}
                contextualRetrievalMode={effectiveContextualRetrievalMode}
                onContextualRetrievalModeChange={() => {}}
                onAddApiKey={setEvaluationAddKeyPurpose}
                disabled={!hasPermission || isEmbeddingModelLocked}
                required={{
                  embedding:
                    embeddingSetupStep === "add-key" ||
                    embeddingSetupStep === "select-key" ||
                    embeddingSetupStep === "select-model",
                }}
                embeddingAfterFields={
                  <>
                    {embeddingModel &&
                      selectedEmbeddingProvider &&
                      noticeDismissalScope && (
                        <EmbeddingModelImageSupportNotice
                          modelId={embeddingModel}
                          provider={selectedEmbeddingProvider}
                          dismissalScope={noticeDismissalScope}
                          supportsImages={
                            selectedEmbeddingCatalogModel
                              ? embeddingModelSupportsImages(
                                  selectedEmbeddingCatalogModel,
                                )
                              : null
                          }
                          showSettingsLink={false}
                          className="sm:ml-auto sm:w-80 sm:flex-col sm:items-stretch sm:gap-2.5"
                        />
                      )}
                    {selectedEmbeddingProvider === "gemini" &&
                      selectedEmbeddingModel?.embeddingDimensions === 1536 && (
                        <p className="flex items-start gap-2 text-xs text-muted-foreground sm:ml-auto sm:w-80">
                          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          <span>
                            Gemini will truncate from its native 3072 dimensions
                            via outputDimensionality.
                          </span>
                        </p>
                      )}
                    {embeddingStatus.status === "failed" &&
                      embeddingStatus.error && (
                        <p className="flex items-start gap-2 text-sm text-destructive sm:ml-auto sm:w-80">
                          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                          <span>{embeddingStatus.error}</span>
                        </p>
                      )}
                    <DropEmbeddingConfigDialog
                      open={showDropDialog}
                      onOpenChange={setShowDropDialog}
                    />
                  </>
                }
              />
            )}
          </WithPermissions>
          {showEmbeddingFooter && (
            <div
              className={cn(
                "mt-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between",
                isEmbeddingModelLocked
                  ? "rounded-lg border border-border/60 bg-muted/30 px-4 py-3"
                  : "border-t pt-4",
              )}
            >
              {isEmbeddingModelLocked ? (
                <div className="flex min-w-0 items-start gap-3 sm:max-w-md">
                  <div className="rounded-md border bg-background p-2 text-muted-foreground shadow-xs">
                    <Lock className="size-4" />
                  </div>
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-sm font-medium">
                      Embedding index locked
                    </p>
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      Drop the index to change models. All documents will need
                      to be re-embedded afterward.
                    </p>
                  </div>
                </div>
              ) : (
                <span />
              )}
              <WithPermissions
                permissions={{ knowledgeSettings: ["update"] }}
                noPermissionHandle="tooltip"
              >
                {({ hasPermission }) => (
                  <KnowledgeConnectionActions
                    configured={embeddingConfigured}
                    status={embeddingStatus.status}
                    onTest={handleTestEmbedding}
                    disabled={!hasPermission}
                    clearLabel={
                      isEmbeddingModelLocked ? "Drop index" : undefined
                    }
                    onClear={
                      isEmbeddingModelLocked
                        ? () => setShowDropDialog(true)
                        : undefined
                    }
                    clearVariant="destructive"
                  />
                )}
              </WithPermissions>
            </div>
          )}
        </SettingsBlock>

        <SettingsBlock
          id="search-ranking-configuration"
          title="Search Ranking Configuration"
          description={
            <>
              Orders the passages a search has found. Reranking reads the
              shortlist and puts the passages that answer the question first;
              keyword ranking scores them by the words they share with the
              question. Changes apply to the next search — nothing is
              re-indexed.
            </>
          }
        >
          <WithPermissions
            permissions={{ knowledgeSettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <KnowledgeConfigurationFields
                sections={["search-ranking"]}
                showTopLevelHeadings={false}
                embedding={{
                  chatApiKeyId: embeddingChatApiKeyId,
                  model: embeddingModel,
                }}
                onEmbeddingChange={() => {}}
                reranker={{
                  chatApiKeyId: rerankerChatApiKeyId,
                  model: rerankerModel,
                }}
                onRerankerChange={(value) => {
                  setRerankerChatApiKeyId(value.chatApiKeyId);
                  setRerankerModel(value.model);
                }}
                ocr={{ chatApiKeyId: ocrChatApiKeyId, model: ocrModel }}
                onOcrChange={() => {}}
                bm25K1={bm25K1Value}
                bm25B={bm25BValue}
                onBm25K1Change={setBm25K1Text}
                onBm25BChange={setBm25BText}
                onBm25K1Blur={() => {
                  if (bm25K1Text?.trim() === "") setBm25K1Text(null);
                }}
                onBm25BBlur={() => {
                  if (bm25BText?.trim() === "") setBm25BText(null);
                }}
                contextualRetrievalMode={effectiveContextualRetrievalMode}
                onContextualRetrievalModeChange={setContextualRetrievalMode}
                onAddApiKey={setEvaluationAddKeyPurpose}
                disabled={!hasPermission}
                required={{
                  reranker: !embeddingSetupStep && Boolean(rerankerSetupStep),
                }}
                keywordStatus={
                  keywordRankingStatus ? (
                    <KeywordRankingStatusLine status={keywordRankingStatus} />
                  ) : undefined
                }
                rerankerAfterFields={
                  rerankerStatus.status === "failed" && rerankerStatus.error ? (
                    <p className="flex items-start gap-2 text-sm text-destructive sm:ml-auto sm:w-80">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{rerankerStatus.error}</span>
                    </p>
                  ) : null
                }
                contextualAfterFields={
                  effectiveContextualRetrievalMode !== "disabled" &&
                  !rerankerConfigured ? (
                    <p className="flex items-start gap-2 text-xs text-muted-foreground sm:pl-44">
                      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>
                        Configure a chat reranking model before ingestion can
                        add context.
                      </span>
                    </p>
                  ) : null
                }
              />
            )}
          </WithPermissions>
          {(rerankerChatApiKeyId || rerankerModel) && (
            <div className="mt-5 flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
              <span />
              <WithPermissions
                permissions={{ knowledgeSettings: ["update"] }}
                noPermissionHandle="tooltip"
              >
                {({ hasPermission }) => (
                  <KnowledgeConnectionActions
                    configured={rerankerConfigured}
                    status={rerankerStatus.status}
                    onTest={handleTestReranker}
                    disabled={!hasPermission}
                    clearLabel="Clear reranking configuration"
                    onClear={() => {
                      setRerankerChatApiKeyId(null);
                      setRerankerModel(null);
                    }}
                  />
                )}
              </WithPermissions>
            </div>
          )}
        </SettingsBlock>

        <SettingsBlock
          id="document-ocr"
          title="Document OCR"
          description={
            <>
              Reads the text in scanned or image-only PDF pages — a signed
              contract that was scanned, for example — so those documents show
              up in search like any other. Without it, such pages are skipped.
              Each transcribed page is one metered model call, visible in LLM
              cost statistics. Optional.
            </>
          }
        >
          <WithPermissions
            permissions={{ knowledgeSettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <KnowledgeConfigurationFields
                sections={["ocr"]}
                showTopLevelHeadings={false}
                embedding={{
                  chatApiKeyId: embeddingChatApiKeyId,
                  model: embeddingModel,
                }}
                onEmbeddingChange={() => {}}
                reranker={{
                  chatApiKeyId: rerankerChatApiKeyId,
                  model: rerankerModel,
                }}
                onRerankerChange={() => {}}
                ocr={{ chatApiKeyId: ocrChatApiKeyId, model: ocrModel }}
                onOcrChange={(value) => {
                  setOcrChatApiKeyId(value.chatApiKeyId);
                  setOcrModel(value.model);
                }}
                bm25K1={bm25K1Value}
                bm25B={bm25BValue}
                onBm25K1Change={() => {}}
                onBm25BChange={() => {}}
                contextualRetrievalMode={effectiveContextualRetrievalMode}
                onContextualRetrievalModeChange={() => {}}
                onAddApiKey={setEvaluationAddKeyPurpose}
                disabled={!hasPermission}
                ocrAfterFields={
                  <>
                    {ocrConfigured && !ocrWasEnabled && (
                      <p className="flex items-start gap-2 text-xs text-muted-foreground sm:ml-auto sm:w-80">
                        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>
                          Saving triggers a full re-sync of every connector so
                          documents previously skipped as unreadable are picked
                          up.
                        </span>
                      </p>
                    )}
                    {ocrStatus.status === "failed" && ocrStatus.error && (
                      <p className="flex items-start gap-2 text-sm text-destructive sm:ml-auto sm:w-80">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>{ocrStatus.error}</span>
                      </p>
                    )}
                  </>
                }
              />
            )}
          </WithPermissions>
          {(ocrChatApiKeyId || ocrModel) && (
            <div className="mt-5 flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
              <span />
              <WithPermissions
                permissions={{ knowledgeSettings: ["update"] }}
                noPermissionHandle="tooltip"
              >
                {({ hasPermission }) => (
                  <KnowledgeConnectionActions
                    configured={ocrConfigured}
                    status={ocrStatus.status}
                    onTest={handleTestOcr}
                    disabled={!hasPermission}
                    clearLabel="Clear OCR configuration"
                    onClear={() => {
                      setOcrChatApiKeyId(null);
                      setOcrModel(null);
                    }}
                  />
                )}
              </WithPermissions>
            </div>
          )}
        </SettingsBlock>

        {knowledgeEvaluationBetaEnabled && (
          <SettingsBlock
            id="retrieval-evaluation-card"
            title={
              <span className="flex items-center gap-2">
                Knowledge Configuration Evaluation
                <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                  Beta
                </Badge>
              </span>
            }
            description="Retest changed Knowledge settings against fixed checks before and after reconfiguration."
          >
            <RetrievalEvaluationSection
              bm25K1={bm25K1}
              bm25B={bm25B}
              embeddingChatApiKeyId={embeddingChatApiKeyId}
              embeddingModel={embeddingModel}
              rerankerChatApiKeyId={rerankerChatApiKeyId}
              rerankerModel={rerankerModel}
              ocrChatApiKeyId={ocrChatApiKeyId}
              ocrModel={ocrModel}
              contextualRetrievalMode={effectiveContextualRetrievalMode}
              onAddApiKey={setEvaluationAddKeyPurpose}
            />
          </SettingsBlock>
        )}

        <SettingsSaveBar
          hasChanges={hasChanges}
          isSaving={updateKnowledgeSettings.isPending}
          disabledSave={bm25K1Invalid || bm25BInvalid}
          permissions={{ knowledgeSettings: ["update"] }}
          onSave={handleSave}
          onCancel={handleCancel}
        />

        <IntegrationAvailabilitySection
          id="available-connectors"
          catalogKey="knowledgeConnectorOverrides"
          catalog={CONNECTOR_TYPES}
          title="Available connectors"
          description="Which connector types this deployment offers. A type you remove leaves the pickers, and the API refuses to configure it. Connectors that already exist keep syncing until you delete them."
          options={CONNECTOR_TYPES.map((type) => ({
            value: type,
            label: CONNECTOR_TYPE_LABELS[type],
            icon: (
              <ConnectorTypeIcon type={type} className="h-[18px] w-[18px]" />
            ),
          }))}
          placeholder="Select connector types…"
          emptyMessage="No connector types found."
          savedMessage="Available connectors updated"
        />
        <AddApiKeyDialog
          open={evaluationAddKeyPurpose !== null}
          onOpenChange={(open) => !open && setEvaluationAddKeyPurpose(null)}
          forEmbedding={evaluationAddKeyPurpose === "embedding"}
          forOcr={evaluationAddKeyPurpose === "ocr"}
        />
      </SettingsSectionStack>
    </LoadingWrapper>
  );
}

const CONNECTOR_TYPES = Object.keys(CONNECTOR_TYPE_LABELS) as ConnectorType[];

export default function KnowledgeSettingsPage() {
  return (
    <ErrorBoundary>
      <SmallTeamTierBanner />
      <KnowledgeSettingsContent />
    </ErrorBoundary>
  );
}
