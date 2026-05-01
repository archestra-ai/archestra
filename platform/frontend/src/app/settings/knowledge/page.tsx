"use client";

import { PROVIDERS_WITH_OPTIONAL_API_KEY } from "@shared";
import {
  ArrowUpRight,
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
  SettingsSaveBar,
  SettingsSectionStack,
} from "@/components/settings/settings-block";
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
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  useUpdateKnowledgeSettings,
} from "@/lib/organization.query";
import { cn } from "@/lib/utils";

const DEFAULT_FORM_VALUES: LlmProviderApiKeyFormValues = {
  name: "",
  provider: "openai",
  apiKey: null,
  baseUrl: null,
  extraHeaders: [],
  scope: "org",
  teamId: null,
  vaultSecretPath: null,
  vaultSecretKey: null,
  isPrimary: true,
};

const EMBEDDING_DEFAULT_FORM_VALUES: LlmProviderApiKeyFormValues = {
  ...DEFAULT_FORM_VALUES,
};
const KNOWLEDGE_MODEL_POPOVER_CLASS =
  "w-max min-w-[var(--radix-popover-trigger-width)] max-w-[min(32rem,calc(100vw-2rem))]";
const KNOWLEDGE_MODEL_POPOVER_LIST_CLASS =
  "max-h-[min(220px,calc(var(--radix-popover-content-available-height)-3rem))]";

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
  const prevSelectableCountRef = useRef<number | null>(null);

  const allKeys = apiKeys ?? [];
  const keys = allowedKeyIds
    ? allKeys.filter((k) => allowedKeyIds.has(k.id))
    : allKeys;
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
  const { data: modelsWithApiKeys } = useModelsWithApiKeys();
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
  const showTestConnection =
    !!embeddingChatApiKeyId && !!embeddingModel && !isEmbeddingModelLocked;
  const showEmbeddingFooter = isEmbeddingModelLocked || showTestConnection;

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
        <Card>
          <CardHeader>
            <CardTitle>Embedding Configuration</CardTitle>
            <CardDescription className="leading-relaxed">
              Choose the API key and embedding model used for knowledge base
              documents. Only keys with synced models that have configured
              embedding dimensions appear here. Supported dimensions: 768, 1536,
              3072.
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
                          "animate-pulse ring-2 ring-primary/40",
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
                      href="/llm/providers/models"
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
                    {showTestConnection && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!hasPermission || testConnection.isPending}
                        onClick={() => {
                          if (!embeddingChatApiKeyId || !embeddingModel) return;
                          testConnection.mutate({
                            embeddingChatApiKeyId,
                            embeddingModel,
                          });
                        }}
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
            <CardTitle>Reranking Configuration</CardTitle>
            <CardDescription>
              Configure the LLM used to rerank knowledge base search results for
              improved relevance. Any LLM provider and model can be used.
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
                </div>
              )}
            </WithPermissions>
          </CardContent>
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
      <KnowledgeSettingsContent />
    </ErrorBoundary>
  );
}
