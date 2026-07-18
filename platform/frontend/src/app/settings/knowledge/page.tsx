"use client";

import { isProviderApiKeyOptional } from "@archestra/shared";
import {
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  Info,
  Loader2,
  Lock,
  Plus,
  Trash2,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { LlmModelSearchableSelect } from "@/components/llm-model-select";
import { LlmProviderApiKeyDropdown } from "@/components/llm-provider-api-key-dropdown";
import {
  LLM_PROVIDER_API_KEY_PLACEHOLDER,
  LlmProviderApiKeyForm,
  type LlmProviderApiKeyFormValues,
} from "@/components/llm-provider-api-key-form";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { QueryLoadError } from "@/components/query-load-error";
import { WithPermissions } from "@/components/roles/with-permissions";
import {
  SettingsSaveBar,
  SettingsSectionStack,
} from "@/components/settings/settings-block";
import { SmallTeamTierBanner } from "@/components/small-team-tier-banner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useFeature } from "@/lib/config/config.query";
import {
  useEmbeddingModels,
  useLlmModels,
  useModelsWithApiKeys,
} from "@/lib/llm-models.query";
import {
  useAvailableLlmProviderApiKeys,
  useCreateLlmProviderApiKey,
} from "@/lib/llm-provider-api-keys.query";
import {
  useDropEmbeddingConfig,
  useOrganization,
  useTestEmbeddingConnection,
  useTestRerankerConnection,
  useUpdateKnowledgeSettings,
} from "@/lib/organization.query";
import { cn } from "@/lib/utils";
import {
  type ConnectionStatus,
  type SectionStatus,
  saveResultStatuses,
} from "./knowledge-validation";

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
  openaiAuthMethod: "api-key",
};

const EMBEDDING_DEFAULT_FORM_VALUES: LlmProviderApiKeyFormValues = {
  ...DEFAULT_FORM_VALUES,
};
const KNOWLEDGE_MODEL_POPOVER_CLASS =
  "w-max min-w-[var(--radix-popover-trigger-width)] max-w-[min(32rem,calc(100vw-2rem))]";
const KNOWLEDGE_MODEL_POPOVER_LIST_CLASS =
  "max-h-[min(220px,calc(var(--radix-popover-content-available-height)-3rem))]";

// Static highlight for the next incomplete setup step. A still ring guides the
// eye without the constant blinking of `animate-pulse`.
const SETUP_HIGHLIGHT_CLASS = "ring-2 ring-primary/50";

function CardRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
      <Label className="shrink-0 text-sm text-muted-foreground sm:w-24">
        {label}
      </Label>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function AddApiKeyDialog({
  open,
  onOpenChange,
  forEmbedding = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  forEmbedding?: boolean;
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
            Test & Create
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}

function ApiKeySelector({
  value,
  onChange,
  disabled,
  forEmbedding,
  label,
  pulse,
  allowedKeyIds,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  disabled: boolean;
  forEmbedding?: boolean;
  label: string;
  pulse?: boolean;
  allowedKeyIds?: Set<string>;
}) {
  const { data: apiKeys, isPending } = useAvailableLlmProviderApiKeys();
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [apiKeySelectorOpen, setApiKeySelectorOpen] = useState(false);
  const prevSelectableCountRef = useRef<number | null>(null);

  const allKeys = apiKeys ?? [];
  const keys = allowedKeyIds
    ? allKeys.filter((k) => allowedKeyIds.has(k.id))
    : allKeys;
  const hasKeys = keys.length > 0;

  // Auto-select the first key when transitioning from 0 → N selectable keys
  useEffect(() => {
    if (isPending) return;
    const prevCount = prevSelectableCountRef.current;
    prevSelectableCountRef.current = keys.length;

    if (prevCount === 0 && keys.length > 0 && !value) {
      onChange(keys[0].id);
    }
  }, [keys, value, onChange, isPending]);

  if (isPending) {
    return <LoadingSpinner />;
  }

  if (!hasKeys) {
    return (
      <div className="space-y-2">
        {!disabled && (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn(pulse && SETUP_HIGHLIGHT_CLASS)}
              onClick={() => setShowAddDialog(true)}
            >
              <Plus className="h-3 w-3 mr-1" />
              Add LLM Provider Key
            </Button>
            <AddApiKeyDialog
              open={showAddDialog}
              onOpenChange={setShowAddDialog}
              forEmbedding={forEmbedding}
            />
          </>
        )}
      </div>
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
    />
  );
}

function RerankerModelSelector({
  value,
  onChange,
  disabled,
  selectedKeyId,
  pulse,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  disabled: boolean;
  selectedKeyId: string | null;
  pulse?: boolean;
}) {
  const { data: apiKeys } = useAvailableLlmProviderApiKeys();
  const { data: allModels, isPending: modelsLoading } = useLlmModels();

  const selectedProvider = useMemo(() => {
    if (!selectedKeyId || !apiKeys) return null;
    return apiKeys.find((k) => k.id === selectedKeyId)?.provider ?? null;
  }, [selectedKeyId, apiKeys]);

  const models = useMemo(() => {
    if (!allModels || !selectedProvider) return [];
    return allModels.filter((m) => m.provider === selectedProvider);
  }, [allModels, selectedProvider]);

  if (!selectedKeyId) {
    return (
      <LlmModelSearchableSelect
        value=""
        onValueChange={() => {}}
        placeholder="Select a reranker API key first..."
        options={[]}
        className={cn("w-full")}
        disabled
      />
    );
  }

  if (modelsLoading) {
    return <LoadingSpinner />;
  }

  const rerankerItems = models.map((model) => ({
    value: model.id,
    model: model.displayName ?? model.id,
    provider: model.provider,
  }));

  return (
    <LlmModelSearchableSelect
      value={value ?? ""}
      onValueChange={(v) => onChange(v || null)}
      options={rerankerItems}
      placeholder="Select reranking model..."
      className={cn("w-full", pulse && SETUP_HIGHLIGHT_CLASS)}
      popoverContentClassName={KNOWLEDGE_MODEL_POPOVER_CLASS}
      popoverListClassName={KNOWLEDGE_MODEL_POPOVER_LIST_CLASS}
      popoverSide="bottom"
      popoverAlign="end"
      truncateOptionLabels={false}
      disabled={disabled}
    />
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

function ConnectionStatusPill({ status }: { status: ConnectionStatus }) {
  const pill = {
    untested: {
      label: "Not tested",
      className: "bg-muted text-muted-foreground",
      icon: null,
    },
    testing: {
      label: "Testing…",
      className: "bg-muted text-muted-foreground",
      icon: <Loader2 className="h-3 w-3 animate-spin" />,
    },
    connected: {
      label: "Connected",
      className: "bg-green-500/10 text-green-600 dark:text-green-400",
      icon: <CheckCircle2 className="h-3 w-3" />,
    },
    failed: {
      label: "Failed",
      className: "bg-destructive/10 text-destructive",
      icon: <AlertCircle className="h-3 w-3" />,
    },
  }[status];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        pill.className,
      )}
    >
      {pill.icon}
      {pill.label}
    </span>
  );
}

function KnowledgeSettingsContent() {
  const { data: organization, isPending } = useOrganization();
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
  const testRerankerConnection = useTestRerankerConnection();
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

  const [embeddingModel, setEmbeddingModel] = useState<string | null>(null);
  const [embeddingChatApiKeyId, setEmbeddingChatApiKeyId] = useState<
    string | null
  >(null);
  const [rerankerChatApiKeyId, setRerankerChatApiKeyId] = useState<
    string | null
  >(null);
  const [rerankerModel, setRerankerModel] = useState<string | null>(null);

  const { data: embeddingModels } = useEmbeddingModels(embeddingChatApiKeyId);
  const {
    data: modelsWithApiKeys,
    isLoadingError: isModelsWithApiKeysLoadError,
    refetch: refetchModelsWithApiKeys,
  } = useModelsWithApiKeys({ toastOnError: false });
  const embeddingCapableKeyIds = useMemo(() => {
    const ids = new Set<string>();
    for (const model of modelsWithApiKeys ?? []) {
      if (model.embeddingDimensions == null) continue;
      for (const key of model.apiKeys) {
        ids.add(key.id);
      }
    }
    return ids;
  }, [modelsWithApiKeys]);
  const selectedEmbeddingApiKey = useMemo(
    () =>
      apiKeys?.find((apiKey) => apiKey.id === embeddingChatApiKeyId) ?? null,
    [apiKeys, embeddingChatApiKeyId],
  );
  const selectedEmbeddingModel = useMemo(
    () => embeddingModels?.find((model) => model.id === embeddingModel) ?? null,
    [embeddingModels, embeddingModel],
  );
  const selectedEmbeddingProvider =
    selectedEmbeddingApiKey?.provider ??
    selectedEmbeddingModel?.provider ??
    null;
  const embeddingEmptyMessage = selectedEmbeddingApiKey
    ? `No embedding models detected for "${selectedEmbeddingApiKey.name}".`
    : "Select an embedding API key first.";

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
    }
  }, [organization]);

  // Changing a section's key/model invalidates its last connection result.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on config change only
  useEffect(() => {
    setEmbeddingStatus({ status: "untested", error: null });
  }, [embeddingChatApiKeyId, embeddingModel]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on config change only
  useEffect(() => {
    setRerankerStatus({ status: "untested", error: null });
  }, [rerankerChatApiKeyId, rerankerModel]);

  // A stable signature of each section's current config. An in-flight test or
  // save captures the signature it ran against and only applies its result if
  // the signature still matches — so a result that resolves after the user
  // changed the key/model (or cleared it) isn't attributed to the new config.
  const embeddingConfigSig = `${embeddingChatApiKeyId ?? ""}|${embeddingModel ?? ""}`;
  const rerankerConfigSig = `${rerankerChatApiKeyId ?? ""}|${rerankerModel ?? ""}`;
  const embeddingConfigSigRef = useRef(embeddingConfigSig);
  const rerankerConfigSigRef = useRef(rerankerConfigSig);
  // Sync the refs during render (not in an effect): the value is derived purely
  // from committed state, so writing it here keeps the ref in lock-step with the
  // current config. An effect would lag by a commit, leaving a window where an
  // in-flight test/save resolves against a stale signature and applies its result
  // to the just-changed config.
  embeddingConfigSigRef.current = embeddingConfigSig;
  rerankerConfigSigRef.current = rerankerConfigSig;

  const serverEmbeddingKeyId = organization?.embeddingChatApiKeyId ?? null;
  const serverEmbeddingModel = serverEmbeddingKeyId
    ? (organization?.embeddingModel ?? null)
    : null;
  const serverRerankerKeyId = organization?.rerankerChatApiKeyId ?? null;
  const serverRerankerModel = organization?.rerankerModel ?? null;

  const hasChanges =
    embeddingModel !== serverEmbeddingModel ||
    embeddingChatApiKeyId !== serverEmbeddingKeyId ||
    rerankerChatApiKeyId !== serverRerankerKeyId ||
    rerankerModel !== serverRerankerModel;

  // Embedding model is locked once both key and model have been saved
  const isEmbeddingModelLocked =
    !!serverEmbeddingKeyId && !!serverEmbeddingModel;
  const embeddingConfigured = !!embeddingChatApiKeyId && !!embeddingModel;
  const rerankerConfigured = !!rerankerChatApiKeyId && !!rerankerModel;
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

  const handleSave = async () => {
    // Snapshot what we're validating so a save that resolves after the user
    // edited a section doesn't stamp its result onto the changed config.
    const embeddingSig = embeddingConfigSig;
    const rerankerSig = rerankerConfigSig;
    const savedEmbeddingConfigured = embeddingConfigured;
    const savedRerankerConfigured = rerankerConfigured;
    // Drive each configured section's pill through the save; the checks run
    // server-side and resolve to connected / failed (with the reason) per field.
    if (savedEmbeddingConfigured) {
      setEmbeddingStatus({ status: "testing", error: null });
    }
    if (savedRerankerConfigured) {
      setRerankerStatus({ status: "testing", error: null });
    }
    let saveError: unknown = null;
    try {
      await updateKnowledgeSettings.mutateAsync({
        embeddingModel: embeddingModel ?? undefined,
        embeddingChatApiKeyId: embeddingChatApiKeyId ?? null,
        rerankerChatApiKeyId: rerankerChatApiKeyId ?? null,
        rerankerModel: rerankerModel ?? null,
      });
    } catch (error) {
      saveError = error;
    }
    const next = saveResultStatuses({
      error: saveError,
      embeddingConfigured: savedEmbeddingConfigured,
      rerankerConfigured: savedRerankerConfigured,
    });
    if (embeddingConfigSigRef.current === embeddingSig) {
      setEmbeddingStatus(next.embedding);
    }
    if (rerankerConfigSigRef.current === rerankerSig) {
      setRerankerStatus(next.reranker);
    }
  };

  const handleCancel = () => {
    setEmbeddingModel(serverEmbeddingModel);
    setEmbeddingChatApiKeyId(serverEmbeddingKeyId);
    setRerankerChatApiKeyId(serverRerankerKeyId);
    setRerankerModel(serverRerankerModel);
  };

  // Clear reranker model when switching provider keys
  const handleRerankerKeyChange = (keyId: string | null) => {
    setRerankerChatApiKeyId(keyId);
    if (keyId !== rerankerChatApiKeyId) {
      setRerankerModel(null);
    }
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
      loadingFallback={<LoadingSpinner />}
    >
      <SettingsSectionStack>
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle>Embedding Configuration</CardTitle>
              {embeddingConfigured && (
                <ConnectionStatusPill status={embeddingStatus.status} />
              )}
            </div>
            <CardDescription className="leading-relaxed">
              Choose the API key and embedding model used for knowledge base
              documents. Only keys with synced models that have configured
              embedding dimensions appear here. Supported dimensions: 384, 768,
              1024, 1536, 3072.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <WithPermissions
              permissions={{ knowledgeSettings: ["update"] }}
              noPermissionHandle="tooltip"
            >
              {({ hasPermission }) => (
                <div className="flex flex-col gap-4">
                  <CardRow label="Key">
                    <ApiKeySelector
                      value={embeddingChatApiKeyId}
                      onChange={setEmbeddingChatApiKeyId}
                      disabled={!hasPermission || isEmbeddingModelLocked}
                      forEmbedding
                      label="embedding API key"
                      allowedKeyIds={embeddingCapableKeyIds}
                      pulse={
                        embeddingSetupStep === "add-key" ||
                        embeddingSetupStep === "select-key"
                      }
                    />
                  </CardRow>
                  <CardRow label="Model">
                    <LlmModelSearchableSelect
                      value={embeddingModel ?? ""}
                      onValueChange={(v) => setEmbeddingModel(v || null)}
                      options={(embeddingModels ?? []).map((model) => ({
                        value: model.id,
                        model: model.id,
                        provider: model.provider,
                        badge: model.embeddingDimensions
                          ? `${model.embeddingDimensions} dims`
                          : undefined,
                      }))}
                      placeholder="Select embedding model..."
                      searchPlaceholder="Search embedding models..."
                      emptyMessage={embeddingEmptyMessage}
                      className={cn(
                        "w-full",
                        embeddingSetupStep === "select-model" &&
                          SETUP_HIGHLIGHT_CLASS,
                      )}
                      popoverContentClassName={KNOWLEDGE_MODEL_POPOVER_CLASS}
                      popoverListClassName={KNOWLEDGE_MODEL_POPOVER_LIST_CLASS}
                      popoverSide="bottom"
                      popoverAlign="end"
                      truncateOptionLabels={false}
                      disabled={
                        !hasPermission ||
                        isEmbeddingModelLocked ||
                        !embeddingChatApiKeyId
                      }
                    />
                  </CardRow>
                  <p className="text-sm text-muted-foreground sm:pl-28">
                    Don't see your model?{" "}
                    <Link
                      href="/llm/models"
                      className="inline-flex items-center gap-0.5 text-primary underline-offset-2 hover:underline"
                    >
                      Sync models and configure embedding dimensions
                      <ArrowUpRight className="h-3.5 w-3.5" />
                    </Link>
                  </p>
                  {selectedEmbeddingProvider === "gemini" &&
                    selectedEmbeddingModel?.embeddingDimensions === 1536 && (
                      <p className="flex items-start gap-2 text-xs text-muted-foreground sm:pl-28">
                        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>
                          Gemini will truncate from its native 3072 dimensions
                          via outputDimensionality.
                        </span>
                      </p>
                    )}
                  {embeddingStatus.status === "failed" &&
                    embeddingStatus.error && (
                      <p className="flex items-start gap-2 text-sm text-destructive sm:pl-28">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>{embeddingStatus.error}</span>
                      </p>
                    )}
                  <DropEmbeddingConfigDialog
                    open={showDropDialog}
                    onOpenChange={setShowDropDialog}
                  />
                </div>
              )}
            </WithPermissions>
          </CardContent>
          {showEmbeddingFooter && (
            <CardFooter className="-mb-6 mt-2 flex flex-col gap-3 rounded-b-xl border-t bg-muted/30 py-4 sm:flex-row sm:items-center sm:justify-between">
              {isEmbeddingModelLocked ? (
                <p className="flex items-start gap-2 text-sm text-muted-foreground">
                  <Lock className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    To change the embedding model, drop the existing index — all
                    documents will need to be re-embedded.
                  </span>
                </p>
              ) : (
                <span />
              )}
              <WithPermissions
                permissions={{ knowledgeSettings: ["update"] }}
                noPermissionHandle="tooltip"
              >
                {({ hasPermission }) => (
                  <div className="flex flex-wrap justify-end gap-2">
                    {embeddingConfigured && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={
                          !hasPermission || embeddingStatus.status === "testing"
                        }
                        onClick={handleTestEmbedding}
                      >
                        {embeddingStatus.status === "testing" ? (
                          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Zap className="mr-1 h-3.5 w-3.5" />
                        )}
                        Test connection
                      </Button>
                    )}
                    {isEmbeddingModelLocked && (
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        disabled={!hasPermission}
                        onClick={() => setShowDropDialog(true)}
                      >
                        <Trash2 className="mr-1 h-3.5 w-3.5" />
                        Drop
                      </Button>
                    )}
                  </div>
                )}
              </WithPermissions>
            </CardFooter>
          )}
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle>Reranking Configuration</CardTitle>
              {rerankerConfigured && (
                <ConnectionStatusPill status={rerankerStatus.status} />
              )}
            </div>
            <CardDescription>
              Configure the LLM used to rerank knowledge base search results for
              improved relevance. Any LLM provider and model can be used —
              reranking is optional.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <WithPermissions
              permissions={{ knowledgeSettings: ["update"] }}
              noPermissionHandle="tooltip"
            >
              {({ hasPermission }) => (
                <div className="flex flex-col gap-4">
                  <CardRow label="Key">
                    <ApiKeySelector
                      value={rerankerChatApiKeyId}
                      onChange={handleRerankerKeyChange}
                      disabled={!hasPermission}
                      label="reranker API key"
                      pulse={
                        !embeddingSetupStep &&
                        (rerankerSetupStep === "add-key" ||
                          rerankerSetupStep === "select-key")
                      }
                    />
                  </CardRow>
                  <CardRow label="Model">
                    <RerankerModelSelector
                      value={rerankerModel}
                      onChange={setRerankerModel}
                      disabled={!hasPermission}
                      selectedKeyId={rerankerChatApiKeyId}
                      pulse={
                        !embeddingSetupStep &&
                        rerankerSetupStep === "select-model"
                      }
                    />
                  </CardRow>
                  {rerankerStatus.status === "failed" &&
                    rerankerStatus.error && (
                      <p className="flex items-start gap-2 text-sm text-destructive sm:pl-28">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>{rerankerStatus.error}</span>
                      </p>
                    )}
                </div>
              )}
            </WithPermissions>
          </CardContent>
          {(rerankerChatApiKeyId || rerankerModel) && (
            <CardFooter className="-mb-6 mt-2 flex flex-col gap-3 rounded-b-xl border-t bg-muted/30 py-4 sm:flex-row sm:items-center sm:justify-between">
              <span />
              <WithPermissions
                permissions={{ knowledgeSettings: ["update"] }}
                noPermissionHandle="tooltip"
              >
                {({ hasPermission }) => (
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!hasPermission}
                      onClick={() => {
                        setRerankerChatApiKeyId(null);
                        setRerankerModel(null);
                      }}
                    >
                      <Trash2 className="mr-1 h-3.5 w-3.5" />
                      Clear reranking configuration
                    </Button>
                    {rerankerConfigured && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={
                          !hasPermission || rerankerStatus.status === "testing"
                        }
                        onClick={handleTestReranker}
                      >
                        {rerankerStatus.status === "testing" ? (
                          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Zap className="mr-1 h-3.5 w-3.5" />
                        )}
                        Test connection
                      </Button>
                    )}
                  </div>
                )}
              </WithPermissions>
            </CardFooter>
          )}
        </Card>

        <SettingsSaveBar
          hasChanges={hasChanges}
          isSaving={updateKnowledgeSettings.isPending}
          permissions={{ knowledgeSettings: ["update"] }}
          onSave={handleSave}
          onCancel={handleCancel}
        />
      </SettingsSectionStack>
    </LoadingWrapper>
  );
}

export default function KnowledgeSettingsPage() {
  return (
    <ErrorBoundary>
      <SmallTeamTierBanner featureName="Knowledge" />
      <KnowledgeSettingsContent />
    </ErrorBoundary>
  );
}
