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
import { useEffect, useState } from "react";
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
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useAvailableChatApiKeys,
  useCreateChatApiKey,
} from "@/lib/chat-settings.query";
import { useFeature } from "@/lib/config.query";
import {
  useOrganization,
  useUpdateKnowledgeSettings,
} from "@/lib/organization.query";

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

function AddApiKeyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createMutation = useCreateChatApiKey();
  const byosEnabled = useFeature("byosEnabled");
  const geminiVertexAiEnabled = useFeature("geminiVertexAiEnabled");

  const form = useForm<ChatApiKeyFormValues>({
    defaultValues: DEFAULT_FORM_VALUES,
  });

  useEffect(() => {
    if (open) {
      form.reset(DEFAULT_FORM_VALUES);
    }
  }, [open, form]);

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
            Add an LLM provider API key for knowledge base embedding and
            reranking
          </DialogDescription>
        </DialogHeader>
        <DialogForm onSubmit={handleCreate}>
          <div className="py-2">
            <ChatApiKeyForm
              mode="full"
              showConsoleLink
              form={form}
              isPending={createMutation.isPending}
              geminiVertexAiEnabled={geminiVertexAiEnabled}
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
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  disabled: boolean;
  filterProvider?: string;
  label: string;
}) {
  const { data: apiKeys, isPending } = useAvailableChatApiKeys();
  const [showAddDialog, setShowAddDialog] = useState(false);

  if (isPending) {
    return <LoadingSpinner />;
  }

  const keys = apiKeys ?? [];
  const openaiKeys = keys.filter((k) => k.provider === "openai");
  const otherKeys = keys.filter((k) => k.provider !== "openai");
  const isEmbeddingSelector = filterProvider === "openai";

  return (
    <div className="space-y-2">
      <Select
        value={value ?? ""}
        onValueChange={(v) => onChange(v || null)}
        disabled={disabled}
      >
        <SelectTrigger className="w-80">
          <SelectValue placeholder={`Select ${label}...`}>
            {value
              ? (keys.find((k) => k.id === value)?.name ?? "Selected key")
              : `Select ${label}...`}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {keys.length === 0 && (
            <div className="px-2 py-3 text-sm text-muted-foreground text-center">
              No LLM provider keys available
            </div>
          )}
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

      {!disabled && (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowAddDialog(true)}
          >
            <Plus className="h-3 w-3 mr-1" />
            Add LLM Provider Key
          </Button>
          <AddApiKeyDialog
            open={showAddDialog}
            onOpenChange={setShowAddDialog}
          />
        </>
      )}
    </div>
  );
}

function KnowledgeSettingsContent() {
  const { data: organization, isPending } = useOrganization();
  const updateKnowledgeSettings = useUpdateKnowledgeSettings(
    "Knowledge settings updated",
    "Failed to update knowledge settings",
  );

  const [embeddingModel, setEmbeddingModel] = useState<EmbeddingModel>(
    "text-embedding-3-small",
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
      setEmbeddingModel(
        (organization.embeddingModel as EmbeddingModel | null) ??
          "text-embedding-3-small",
      );
      setEmbeddingChatApiKeyId(
        (organization as Record<string, unknown>).embeddingChatApiKeyId as
          | string
          | null,
      );
      setRerankerChatApiKeyId(
        (organization as Record<string, unknown>).rerankerChatApiKeyId as
          | string
          | null,
      );
      setRerankerModel(
        (organization as Record<string, unknown>).rerankerModel as
          | string
          | null,
      );
    }
  }, [organization]);

  const serverEmbeddingModel =
    (organization?.embeddingModel as EmbeddingModel | null) ??
    "text-embedding-3-small";
  const serverEmbeddingKeyId = (
    organization as Record<string, unknown> | undefined
  )?.embeddingChatApiKeyId as string | null | undefined;
  const serverRerankerKeyId = (
    organization as Record<string, unknown> | undefined
  )?.rerankerChatApiKeyId as string | null | undefined;
  const serverRerankerModel = (
    organization as Record<string, unknown> | undefined
  )?.rerankerModel as string | null | undefined;

  const hasChanges =
    embeddingModel !== serverEmbeddingModel ||
    embeddingChatApiKeyId !== (serverEmbeddingKeyId ?? null) ||
    rerankerChatApiKeyId !== (serverRerankerKeyId ?? null) ||
    rerankerModel !== (serverRerankerModel ?? null);

  // Embedding model is locked once it's been set and an API key is configured
  const isEmbeddingModelLocked =
    !!serverEmbeddingKeyId && !!organization?.embeddingModel;

  const handleSave = async () => {
    await updateKnowledgeSettings.mutateAsync({
      embeddingModel,
      embeddingChatApiKeyId: embeddingChatApiKeyId ?? null,
      rerankerChatApiKeyId: rerankerChatApiKeyId ?? null,
      rerankerModel: rerankerModel ?? null,
    });
  };

  const handleCancel = () => {
    setEmbeddingModel(serverEmbeddingModel);
    setEmbeddingChatApiKeyId(serverEmbeddingKeyId ?? null);
    setRerankerChatApiKeyId(serverRerankerKeyId ?? null);
    setRerankerModel(serverRerankerModel ?? null);
  };

  return (
    <LoadingWrapper isPending={isPending} loadingFallback={<LoadingSpinner />}>
      <div className="space-y-8">
        {/* Embedding Configuration */}
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Settings className="h-5 w-5 text-muted-foreground" />
            <h3 className="text-lg font-semibold">Embedding Configuration</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            Configure the API key and model used to generate vector embeddings
            for knowledge base documents.
          </p>

          <SettingsBlock
            title="LLM Provider API Key"
            description="Select an OpenAI API key for generating embeddings. Only OpenAI embedding models are currently supported."
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
                  />
                )}
              </WithPermissions>
            }
          />

          <SettingsBlock
            title="Embedding Model"
            description={
              isEmbeddingModelLocked
                ? "The embedding model cannot be changed after documents have been embedded. Support for changing the embedding model after initial selection is coming soon."
                : "Select the model used to generate vector embeddings. This choice is permanent once documents are embedded."
            }
            control={
              <WithPermissions
                permissions={{ knowledgeSettings: ["update"] }}
                noPermissionHandle="tooltip"
              >
                {({ hasPermission }) => (
                  <div className="space-y-2">
                    <Select
                      value={embeddingModel}
                      onValueChange={(v) =>
                        setEmbeddingModel(v as EmbeddingModel)
                      }
                      disabled={!hasPermission || isEmbeddingModelLocked}
                    >
                      <SelectTrigger className="w-80">
                        <SelectValue placeholder="Select model">
                          <div className="flex items-center gap-2">
                            {isEmbeddingModelLocked && (
                              <Lock className="h-3 w-3" />
                            )}
                            {embeddingModel}
                          </div>
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {EMBEDDING_MODELS.map((model) => (
                          <SelectItem key={model.value} value={model.value}>
                            <div className="flex flex-col">
                              <span>{model.label}</span>
                              <span className="text-xs text-muted-foreground">
                                {model.description}
                              </span>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {isEmbeddingModelLocked && (
                      <Alert variant="default" className="py-2">
                        <Info className="h-4 w-4" />
                        <AlertDescription className="text-xs">
                          Changing the embedding model requires re-embedding all
                          documents. This feature is coming soon.
                        </AlertDescription>
                      </Alert>
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
                    onChange={setRerankerChatApiKeyId}
                    disabled={!hasPermission}
                    label="reranker API key"
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
                  <Input
                    className="w-80"
                    placeholder="e.g. gpt-4o"
                    value={rerankerModel ?? ""}
                    onChange={(e) => setRerankerModel(e.target.value || null)}
                    disabled={!hasPermission}
                  />
                )}
              </WithPermissions>
            }
          />
        </div>

        {!embeddingChatApiKeyId && !rerankerChatApiKeyId && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Knowledge base requires LLM provider API keys to be configured.
              Select existing keys above or add a new one.
            </AlertDescription>
          </Alert>
        )}

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
