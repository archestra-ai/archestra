"use client";

import { PROVIDERS_WITH_OPTIONAL_API_KEY } from "@shared";
import {
  AlertTriangle,
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
import {
  LLM_PROVIDER_API_KEY_PLACEHOLDER,
  LlmProviderApiKeyForm,
  type LlmProviderApiKeyFormValues,
  PROVIDER_CONFIG,
} from "@/components/llm-provider-api-key-form";
import {
  LlmProviderApiKeyOptionLabel,
  LlmProviderApiKeySelectItems,
} from "@/components/llm-provider-options";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { WithPermissions } from "@/components/roles/with-permissions";
import {
  SettingsBlock,
  SettingsSaveBar,
  SettingsSectionStack,
} from "@/components/settings/settings-block";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useFeature } from "@/lib/config/config.query";
import { useEmbeddingModels, useLlmModels } from "@/lib/llm-models.query";
import {
  useAvailableLlmProviderApiKeys,
  useCreateLlmProviderApiKey,
} from "@/lib/llm-provider-api-keys.query";
import {
  useDropEmbeddingConfig,
  useOrganization,
  useTestEmbeddingConnection,
  useUpdateKnowledgeSettings,
} from "@/lib/organization.query";
import { cn } from "@/lib/utils";

const DEFAULT_FORM_VALUES: LlmProviderApiKeyFormValues = {
  name: "",
  provider: "openai",
  apiKey: null,
  baseUrl: null,
  scope: "org",
  teamId: null,
  vaultSecretPath: null,
  vaultSecretKey: null,
  isPrimary: true,
};

const EMBEDDING_DEFAULT_FORM_VALUES: LlmProviderApiKeyFormValues = {
  ...DEFAULT_FORM_VALUES,
};
const KNOWLEDGE_SETTINGS_CONTROL_CLASS = "w-full max-w-[28rem]";

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
      : PROVIDERS_WITH_OPTIONAL_API_KEY.has(formValues.provider) ||
        formValues.apiKey);

  const handleCreate = form.handleSubmit(async (values) => {
    try {
      await createMutation.mutateAsync({
        name: values.name,
        provider: values.provider,
        apiKey: values.apiKey || undefined,
        baseUrl: values.baseUrl || undefined,
        scope: values.scope,
        teamId:
          values.scope === "team" && values.teamId ? values.teamId : undefined,
        isPrimary: values.isPrimary,
        vaultSecretPath:
          byosEnabled && values.vaultSecretPath
            ? values.vaultSecretPath
            : undefined,
        vaultSecretKey:
          byosEnabled && values.vaultSecretKey
            ? values.vaultSecretKey
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
          {forEmbedding && (
            <Alert variant="default">
              <Info className="h-4 w-4" />
              <AlertDescription className="text-xs">
                After adding the key, sync models and mark an embedding model
                via the model catalog (LLM Providers &gt; Models).
              </AlertDescription>
            </Alert>
          )}
          <LlmProviderApiKeyForm
            mode="full"
            showConsoleLink={false}
            form={form}
            isPending={createMutation.isPending}
            bedrockIamAuthEnabled={bedrockIamAuthEnabled}
            geminiVertexAiEnabled={geminiVertexAiEnabled}
            hideScopeAndPrimary
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
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
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
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  disabled: boolean;
  forEmbedding?: boolean;
  label: string;
  pulse?: boolean;
}) {
  const { data: apiKeys, isPending } = useAvailableLlmProviderApiKeys();
  const [showAddDialog, setShowAddDialog] = useState(false);
  const prevSelectableCountRef = useRef<number | null>(null);

  const keys = apiKeys ?? [];
  const hasKeys = keys.length > 0;
  const selectedKey = keys.find((key) => key.id === value) ?? null;

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
              className={cn(pulse && "animate-pulse ring-2 ring-primary/40")}
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
    <div className="space-y-2">
      <Select
        value={value ?? ""}
        onValueChange={(v) => onChange(v || null)}
        disabled={disabled}
      >
        <SelectTrigger
          className={cn(
            "w-full",
            pulse && "animate-pulse ring-2 ring-primary/40",
          )}
        >
          <SelectValue placeholder={`Select ${label}...`}>
            {selectedKey ? (
              <LlmProviderApiKeyOptionLabel
                icon={PROVIDER_CONFIG[selectedKey.provider].icon}
                providerName={PROVIDER_CONFIG[selectedKey.provider].name}
                keyName={selectedKey.name}
                secondaryLabel={`${selectedKey.provider} - ${selectedKey.scope}`}
              />
            ) : (
              `Select ${label}...`
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <LlmProviderApiKeySelectItems
            options={keys.map((key) => ({
              value: key.id,
              icon: PROVIDER_CONFIG[key.provider].icon,
              providerName: PROVIDER_CONFIG[key.provider].name,
              keyName: key.name,
              secondaryLabel: `${key.provider} - ${key.scope}`,
            }))}
          />
        </SelectContent>
      </Select>
    </div>
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
      className={cn("w-full", pulse && "animate-pulse ring-2 ring-primary/40")}
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
      title="Drop Embedding Configuration"
      description={
        <div className="space-y-3">
          <p>
            This will delete all embedded documents and reset connector
            checkpoints. Connectors and knowledge bases are preserved — the next
            sync will re-ingest everything with the new embedding model.
          </p>
          <Alert variant="destructive" className="py-2">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              All embedded documents will be permanently deleted. Connectors and
              knowledge bases will not be affected.
            </AlertDescription>
          </Alert>
        </div>
      }
      isPending={dropMutation.isPending}
      onConfirm={handleDrop}
      confirmLabel="Drop Embedding Config"
      pendingLabel="Dropping..."
    />
  );
}

function KnowledgeSettingsContent() {
  const { data: organization, isPending } = useOrganization();
  const { data: apiKeys, isPending: areApiKeysPending } =
    useAvailableLlmProviderApiKeys();
  const updateKnowledgeSettings = useUpdateKnowledgeSettings(
    "Knowledge settings updated",
    "Failed to update knowledge settings",
  );
  const testConnection = useTestEmbeddingConnection();
  const [showDropDialog, setShowDropDialog] = useState(false);

  const [embeddingModel, setEmbeddingModel] = useState<string | null>(null);
  const [embeddingChatApiKeyId, setEmbeddingChatApiKeyId] = useState<
    string | null
  >(null);
  const [rerankerChatApiKeyId, setRerankerChatApiKeyId] = useState<
    string | null
  >(null);
  const [rerankerModel, setRerankerModel] = useState<string | null>(null);

  const { data: embeddingModels } = useEmbeddingModels(embeddingChatApiKeyId);
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
  const showConfigureEmbeddingModelsLink =
    !!embeddingChatApiKeyId &&
    !isEmbeddingModelLocked &&
    (embeddingModels?.length ?? 0) === 0;
  const showSelectEmbeddingKeyHint =
    !embeddingChatApiKeyId && !isEmbeddingModelLocked;
  const showEmbeddingMeta = !!selectedEmbeddingModel || isEmbeddingModelLocked;
  const showEmbeddingSupportText =
    showEmbeddingMeta ||
    showSelectEmbeddingKeyHint ||
    showConfigureEmbeddingModelsLink;
  const showEmbeddingActions =
    isEmbeddingModelLocked || (!!embeddingChatApiKeyId && !!embeddingModel);
  const showEmbeddingSupportPanel =
    showEmbeddingSupportText || showEmbeddingActions;

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

  const isFullyConfigured = !embeddingSetupStep && !rerankerSetupStep;

  const handleSave = async () => {
    await updateKnowledgeSettings.mutateAsync({
      embeddingModel: embeddingModel ?? undefined,
      embeddingChatApiKeyId: embeddingChatApiKeyId ?? null,
      rerankerChatApiKeyId: rerankerChatApiKeyId ?? null,
      rerankerModel: rerankerModel ?? null,
    });
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

  return (
    <LoadingWrapper
      isPending={isInitialLoading}
      loadingFallback={<LoadingSpinner />}
    >
      <SettingsSectionStack>
        {!isInitialLoading && !isFullyConfigured && (
          <Alert variant="warning">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              An embedding and reranking API key and model must be configured
              before knowledge bases and connectors can be used.
            </AlertDescription>
          </Alert>
        )}

        <SettingsBlock
          title="Embedding Configuration"
          description="Choose the API key and embedding model used for knowledge base documents. Only synced models with configured embedding dimensions appear here."
          control={
            <WithPermissions
              permissions={{ knowledgeSettings: ["update"] }}
              noPermissionHandle="tooltip"
            >
              {({ hasPermission }) => (
                <div
                  className={cn(
                    "flex flex-col gap-2.5",
                    KNOWLEDGE_SETTINGS_CONTROL_CLASS,
                  )}
                >
                  <ApiKeySelector
                    value={embeddingChatApiKeyId}
                    onChange={setEmbeddingChatApiKeyId}
                    disabled={!hasPermission}
                    forEmbedding
                    label="embedding API key"
                    pulse={
                      embeddingSetupStep === "add-key" ||
                      embeddingSetupStep === "select-key"
                    }
                  />
                  <LlmModelSearchableSelect
                    value={embeddingModel ?? ""}
                    onValueChange={(v) => setEmbeddingModel(v || null)}
                    options={(embeddingModels ?? []).map((model) => ({
                      value: model.id,
                      model: model.id,
                      provider: model.provider,
                    }))}
                    placeholder="Select embedding model..."
                    searchPlaceholder="Search embedding models..."
                    emptyMessage={embeddingEmptyMessage}
                    className={cn(
                      "w-full",
                      embeddingSetupStep === "select-model" &&
                        "animate-pulse ring-2 ring-primary/40",
                    )}
                    disabled={
                      !hasPermission ||
                      isEmbeddingModelLocked ||
                      !embeddingChatApiKeyId
                    }
                  />
                  {showEmbeddingSupportPanel && (
                    <div className="rounded-xl border border-border/60 bg-muted/20 p-3">
                      <div
                        className={cn(
                          "flex flex-col gap-3",
                          showEmbeddingSupportText &&
                            showEmbeddingActions &&
                            "md:flex-row md:items-start md:justify-between",
                        )}
                      >
                        {showEmbeddingSupportText && (
                          <div className="space-y-1.5">
                            {selectedEmbeddingModel && (
                              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                <span>
                                  Uses{" "}
                                  {selectedEmbeddingModel.embeddingDimensions}
                                  -dimensional vectors.
                                  {selectedEmbeddingProvider === "gemini" &&
                                    selectedEmbeddingModel.embeddingDimensions ===
                                      1536 &&
                                    " Gemini will truncate from its native 3072 dimensions via outputDimensionality."}
                                </span>
                              </p>
                            )}
                            {isEmbeddingModelLocked && (
                              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                                <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                <span>
                                  Locked — changing the embedding model requires
                                  re-embedding all documents.
                                </span>
                              </p>
                            )}
                            {showSelectEmbeddingKeyHint && (
                              <p className="text-xs text-muted-foreground">
                                Select an embedding API key first.
                              </p>
                            )}
                            {showConfigureEmbeddingModelsLink && (
                              <p className="text-xs text-muted-foreground">
                                Configure embedding dimensions for a synced
                                model{" "}
                                <Link
                                  href="/llm/providers/models"
                                  className="text-primary underline underline-offset-2"
                                >
                                  here
                                </Link>
                                .
                              </p>
                            )}
                          </div>
                        )}
                        {showEmbeddingActions && (
                          <div className="flex flex-wrap justify-end gap-2 md:shrink-0">
                            {embeddingChatApiKeyId && embeddingModel && (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={testConnection.isPending}
                                onClick={() =>
                                  testConnection.mutate({
                                    embeddingChatApiKeyId,
                                    embeddingModel,
                                  })
                                }
                              >
                                {testConnection.isPending ? (
                                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Zap className="mr-1 h-3.5 w-3.5" />
                                )}
                                Test Connection
                              </Button>
                            )}
                            {isEmbeddingModelLocked && (
                              <Button
                                type="button"
                                variant="destructive"
                                size="sm"
                                onClick={() => setShowDropDialog(true)}
                              >
                                <Trash2 className="mr-1 h-3.5 w-3.5" />
                                Drop
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  <DropEmbeddingConfigDialog
                    open={showDropDialog}
                    onOpenChange={setShowDropDialog}
                  />
                </div>
              )}
            </WithPermissions>
          }
        />

        <SettingsBlock
          title="Reranking Configuration"
          description="Configure the LLM used to rerank knowledge base search results for improved relevance. Any LLM provider and model can be used."
          control={
            <WithPermissions
              permissions={{ knowledgeSettings: ["update"] }}
              noPermissionHandle="tooltip"
            >
              {({ hasPermission }) => (
                <div
                  className={cn(
                    "flex flex-col gap-2",
                    KNOWLEDGE_SETTINGS_CONTROL_CLASS,
                  )}
                >
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
                </div>
              )}
            </WithPermissions>
          }
        />

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
      <KnowledgeSettingsContent />
    </ErrorBoundary>
  );
}
