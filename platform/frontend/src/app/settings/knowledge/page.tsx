"use client";

import {
  EMBEDDING_MODELS,
  type EmbeddingModel,
  PROVIDERS_WITH_OPTIONAL_API_KEY,
} from "@shared";
import {
  AlertTriangle,
  Info,
  Key,
  Loader2,
  Lock,
  Plus,
  Settings,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import {
  ChatApiKeyForm,
  type ChatApiKeyFormValues,
  PLACEHOLDER_KEY,
} from "@/components/chat-api-key-form";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { WithPermissions } from "@/components/roles/with-permissions";
import {
  SettingsBlock,
  SettingsSaveBar,
} from "@/components/settings/settings-block";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useChatModels } from "@/lib/chat-models.query";
import {
  useAvailableChatApiKeys,
  useCreateChatApiKey,
} from "@/lib/chat-settings.query";
import { useFeature } from "@/lib/config.query";
import {
  useOrganization,
  useUpdateKnowledgeSettings,
} from "@/lib/organization.query";
import { cn } from "@/lib/utils";

const DEFAULT_FORM_VALUES: ChatApiKeyFormValues = {
  name: "",
  provider: "openai",
  apiKey: null,
  baseUrl: null,
  scope: "org_wide",
  teamId: null,
  vaultSecretPath: null,
  vaultSecretKey: null,
  isPrimary: true,
};

const EMBEDDING_DEFAULT_FORM_VALUES: ChatApiKeyFormValues = {
  ...DEFAULT_FORM_VALUES,
  provider: "openai",
};

function AddApiKeyDialog({
  open,
  onOpenChange,
  forEmbedding = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  forEmbedding?: boolean;
}) {
  const createMutation = useCreateChatApiKey();
  const byosEnabled = useFeature("byosEnabled");
  const geminiVertexAiEnabled = useFeature("geminiVertexAiEnabled");

  const defaults = forEmbedding
    ? EMBEDDING_DEFAULT_FORM_VALUES
    : DEFAULT_FORM_VALUES;

  const form = useForm<ChatApiKeyFormValues>({
    defaultValues: defaults,
  });

  useEffect(() => {
    if (open) {
      form.reset(defaults);
    }
  }, [open, form, defaults]);

  const formValues = form.watch();
  const isValid =
    formValues.apiKey !== PLACEHOLDER_KEY &&
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add LLM Provider Key</DialogTitle>
          <DialogDescription>
            {forEmbedding
              ? "Add an OpenAI API key for knowledge base embeddings."
              : "Add an LLM provider API key for knowledge base reranking."}
          </DialogDescription>
        </DialogHeader>
        {forEmbedding && (
          <Alert variant="default" className="py-2">
            <Info className="h-4 w-4" />
            <AlertDescription className="text-xs">
              Only OpenAI is currently supported for embeddings. The key must
              have access to at least one of the following models:
              <ul className="list-disc list-inside mt-1">
                {Object.keys(EMBEDDING_MODELS).map((model) => (
                  <li key={model}>{model}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        <DialogForm onSubmit={handleCreate}>
          <div className="py-2">
            <ChatApiKeyForm
              mode="full"
              showConsoleLink
              form={form}
              isPending={createMutation.isPending}
              geminiVertexAiEnabled={geminiVertexAiEnabled}
              disableProvider={forEmbedding}
              hideScopeAndPrimary
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!isValid || createMutation.isPending}
            >
              {createMutation.isPending && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              Test & Create
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}

function ApiKeySelector({
  value,
  onChange,
  disabled,
  filterProvider,
  label,
  pulse,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  disabled: boolean;
  filterProvider?: string;
  label: string;
  pulse?: boolean;
}) {
  const { data: apiKeys, isPending } = useAvailableChatApiKeys();
  const [showAddDialog, setShowAddDialog] = useState(false);
  const prevSelectableCountRef = useRef<number | null>(null);

  const keys = apiKeys ?? [];
  const openaiKeys = keys.filter((k) => k.provider === "openai");
  const otherKeys = keys.filter((k) => k.provider !== "openai");
  const isEmbeddingSelector = filterProvider === "openai";
  const selectableKeys = isEmbeddingSelector ? openaiKeys : keys;
  const hasSelectableKeys = selectableKeys.length > 0;

  // Auto-select the first key when transitioning from 0 → N selectable keys
  useEffect(() => {
    if (isPending) return;
    const prevCount = prevSelectableCountRef.current;
    prevSelectableCountRef.current = selectableKeys.length;

    if (prevCount === 0 && selectableKeys.length > 0 && !value) {
      onChange(selectableKeys[0].id);
    }
  }, [selectableKeys, value, onChange, isPending]);

  if (isPending) {
    return <LoadingSpinner />;
  }

  if (!hasSelectableKeys) {
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
              forEmbedding={isEmbeddingSelector}
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
            "w-80",
            pulse && "animate-pulse ring-2 ring-primary/40",
          )}
        >
          <SelectValue placeholder={`Select ${label}...`}>
            {value
              ? (keys.find((k) => k.id === value)?.name ?? "Selected key")
              : `Select ${label}...`}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {isEmbeddingSelector ? (
            <>
              {openaiKeys.map((key) => (
                <SelectItem key={key.id} value={key.id}>
                  <div className="flex items-center gap-2">
                    <Key className="h-3 w-3" />
                    <span>{key.name}</span>
                    <span className="text-xs text-muted-foreground">
                      ({key.scope})
                    </span>
                  </div>
                </SelectItem>
              ))}
              {otherKeys.length > 0 && (
                <>
                  <div className="px-2 py-1.5 text-xs text-muted-foreground border-t mt-1 pt-2">
                    Only OpenAI is supported for embeddings
                  </div>
                  {otherKeys.map((key) => (
                    <SelectItem key={key.id} value={key.id} disabled>
                      <div className="flex items-center gap-2 opacity-50">
                        <Key className="h-3 w-3" />
                        <span>{key.name}</span>
                        <span className="text-xs text-muted-foreground">
                          ({key.provider})
                        </span>
                      </div>
                    </SelectItem>
                  ))}
                </>
              )}
            </>
          ) : (
            keys.map((key) => (
              <SelectItem key={key.id} value={key.id}>
                <div className="flex items-center gap-2">
                  <Key className="h-3 w-3" />
                  <span>{key.name}</span>
                  <span className="text-xs text-muted-foreground">
                    ({key.provider} - {key.scope})
                  </span>
                </div>
              </SelectItem>
            ))
          )}
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
  const { data: apiKeys } = useAvailableChatApiKeys();
  const { data: allModels, isPending: modelsLoading } = useChatModels();

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
      <SearchableSelect
        value=""
        onValueChange={() => {}}
        placeholder="Select a reranker API key first..."
        items={[]}
        className={cn("w-80")}
        disabled
      />
    );
  }

  if (modelsLoading) {
    return <LoadingSpinner />;
  }

  const rerankerItems = models.map((model) => ({
    value: model.id,
    label: model.displayName ?? model.id,
  }));

  return (
    <SearchableSelect
      value={value ?? ""}
      onValueChange={(v) => onChange(v || null)}
      placeholder="Select reranking model..."
      searchPlaceholder="Search models..."
      items={rerankerItems}
      className={cn("w-80", pulse && "animate-pulse ring-2 ring-primary/40")}
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

function KnowledgeSettingsContent() {
  const { data: organization, isPending } = useOrganization();
  const { data: apiKeys } = useAvailableChatApiKeys();
  const updateKnowledgeSettings = useUpdateKnowledgeSettings(
    "Knowledge settings updated",
    "Failed to update knowledge settings",
  );

  const [embeddingModel, setEmbeddingModel] = useState<EmbeddingModel | null>(
    null,
  );
  const [embeddingChatApiKeyId, setEmbeddingChatApiKeyId] = useState<
    string | null
  >(null);
  const [rerankerChatApiKeyId, setRerankerChatApiKeyId] = useState<
    string | null
  >(null);
  const [rerankerModel, setRerankerModel] = useState<string | null>(null);

  useEffect(() => {
    if (organization) {
      // Only set embedding model if user has explicitly configured a key
      // (otherwise the database default is not a user choice)
      const hasEmbeddingKey = !!organization.embeddingChatApiKeyId;
      setEmbeddingModel(
        hasEmbeddingKey
          ? ((organization.embeddingModel as EmbeddingModel) ?? null)
          : null,
      );
      setEmbeddingChatApiKeyId(organization.embeddingChatApiKeyId ?? null);
      setRerankerChatApiKeyId(organization.rerankerChatApiKeyId ?? null);
      setRerankerModel(organization.rerankerModel ?? null);
    }
  }, [organization]);

  const serverEmbeddingKeyId = organization?.embeddingChatApiKeyId ?? null;
  const serverEmbeddingModel = serverEmbeddingKeyId
    ? ((organization?.embeddingModel as EmbeddingModel | null) ?? null)
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

  // Check if keys exist for pulsing logic
  const hasOpenAiKeys = useMemo(
    () => (apiKeys ?? []).some((k) => k.provider === "openai"),
    [apiKeys],
  );
  const hasAnyKeys = useMemo(() => (apiKeys ?? []).length > 0, [apiKeys]);

  const embeddingSetupStep = useSetupStep({
    selectedKeyId: embeddingChatApiKeyId,
    selectedModel: embeddingModel,
    hasSelectableKeys: hasOpenAiKeys,
  });

  const rerankerSetupStep = useSetupStep({
    selectedKeyId: rerankerChatApiKeyId,
    selectedModel: rerankerModel,
    hasSelectableKeys: hasAnyKeys,
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
    <LoadingWrapper isPending={isPending} loadingFallback={<LoadingSpinner />}>
      <div className="space-y-8">
        {!isFullyConfigured && (
          <Alert variant="warning">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              An embedding and reranking API key and model must be configured
              before knowledge bases and connectors can be used.
            </AlertDescription>
          </Alert>
        )}

        {/* Embedding Configuration */}
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Settings className="h-5 w-5 text-muted-foreground" />
            <h3 className="text-lg font-semibold">Embedding Configuration</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            Configure the API key and model used to generate vector embeddings
            for knowledge base documents. Only OpenAI embedding models are
            currently supported.
          </p>

          <SettingsBlock
            title="LLM Provider API Key"
            description="Select an OpenAI API key for generating embeddings."
            control={
              <WithPermissions
                permissions={{ knowledgeSettings: ["update"] }}
                noPermissionHandle="tooltip"
              >
                {({ hasPermission }) => (
                  <ApiKeySelector
                    value={embeddingChatApiKeyId}
                    onChange={setEmbeddingChatApiKeyId}
                    disabled={!hasPermission}
                    filterProvider="openai"
                    label="embedding API key"
                    pulse={
                      embeddingSetupStep === "add-key" ||
                      embeddingSetupStep === "select-key"
                    }
                  />
                )}
              </WithPermissions>
            }
          />

          <SettingsBlock
            title="Embedding Model"
            description={
              isEmbeddingModelLocked
                ? "The embedding model cannot be changed after it has been saved. Changing models requires re-embedding all documents."
                : "Select the model used to generate vector embeddings. This choice is permanent once saved."
            }
            control={
              <WithPermissions
                permissions={{ knowledgeSettings: ["update"] }}
                noPermissionHandle="tooltip"
              >
                {({ hasPermission }) => (
                  <div className="space-y-2 w-80">
                    <SearchableSelect
                      value={embeddingModel ?? ""}
                      onValueChange={(v) =>
                        setEmbeddingModel(v as EmbeddingModel)
                      }
                      placeholder="Select embedding model..."
                      searchPlaceholder="Search models..."
                      items={Object.entries(EMBEDDING_MODELS).map(
                        ([value, model]) => ({
                          value,
                          label: model.label,
                          description: model.description,
                        }),
                      )}
                      className={cn(
                        "w-80",
                        embeddingSetupStep === "select-model" &&
                          "animate-pulse ring-2 ring-primary/40",
                      )}
                      disabled={
                        !hasPermission ||
                        isEmbeddingModelLocked ||
                        !embeddingChatApiKeyId
                      }
                    />
                    {isEmbeddingModelLocked && (
                      <p className="text-xs text-muted-foreground">
                        <Lock className="h-3 w-3 inline mr-1" />
                        Locked — changing the embedding model requires
                        re-embedding all documents.
                      </p>
                    )}
                    {!embeddingChatApiKeyId && !isEmbeddingModelLocked && (
                      <p className="text-xs text-muted-foreground">
                        Select an embedding API key first.
                      </p>
                    )}
                  </div>
                )}
              </WithPermissions>
            }
          />
        </div>

        {/* Reranking Configuration */}
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Settings className="h-5 w-5 text-muted-foreground" />
            <h3 className="text-lg font-semibold">Reranking Configuration</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            Configure the LLM used to rerank knowledge base search results for
            improved relevance. Any LLM provider and model can be used.
          </p>

          <SettingsBlock
            title="LLM Provider API Key"
            description="Select an API key from any provider for the reranker LLM."
            control={
              <WithPermissions
                permissions={{ knowledgeSettings: ["update"] }}
                noPermissionHandle="tooltip"
              >
                {({ hasPermission }) => (
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
                )}
              </WithPermissions>
            }
          />

          <SettingsBlock
            title="Reranking Model"
            description="The LLM model used to score and rerank search results. Should support structured output."
            control={
              <WithPermissions
                permissions={{ knowledgeSettings: ["update"] }}
                noPermissionHandle="tooltip"
              >
                {({ hasPermission }) => (
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
                )}
              </WithPermissions>
            }
          />
        </div>

        <SettingsSaveBar
          hasChanges={hasChanges}
          isSaving={updateKnowledgeSettings.isPending}
          permissions={{ knowledgeSettings: ["update"] }}
          onSave={handleSave}
          onCancel={handleCancel}
        />
      </div>
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
