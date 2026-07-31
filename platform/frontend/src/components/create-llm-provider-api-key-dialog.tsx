"use client";

import {
  CHATGPT_SUBSCRIPTION_LABEL,
  isProviderApiKeyOptional,
} from "@archestra/shared";
import { Loader2 } from "lucide-react";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { FormDialog } from "@/components/form-dialog";
import {
  LLM_PROVIDER_API_KEY_PLACEHOLDER,
  LlmProviderApiKeyForm,
  type LlmProviderApiKeyFormValues,
  PROVIDER_CONFIG,
  serializeExtraHeaders,
} from "@/components/llm-provider-api-key-form";
import { Button } from "@/components/ui/button";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import {
  useCreateLlmProviderApiKey,
  useLlmProviderApiKeys,
  useUpdateLlmProviderApiKey,
} from "@/lib/llm-provider-api-keys.query";

export type CreateLlmProviderApiKeyDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  defaultValues?: Partial<LlmProviderApiKeyFormValues>;
  /** Restrict the provider picker to this allowlist (e.g. the providers the
   * selected connect client can actually route). Omit to allow all providers. */
  allowedProviders?: LlmProviderApiKeyFormValues["provider"][];
  /** Selects the focused progressive flow shown by this dialog. */
  credentialMode?: "api-key" | "subscription";
  showConsoleLink?: boolean;
  onSuccess?: () => void;
  /**
   * Re-authentication mode: rotate this existing key's credential in place
   * instead of creating a new key. Used to reconnect an expired personal
   * subscription (ChatGPT/Copilot) without minting a duplicate credential row.
   */
  reconnectKeyId?: string;
};

export function CreateLlmProviderApiKeyDialog({
  open,
  onOpenChange,
  title,
  description,
  defaultValues,
  allowedProviders,
  credentialMode = "api-key",
  showConsoleLink = false,
  onSuccess,
  reconnectKeyId,
}: CreateLlmProviderApiKeyDialogProps) {
  const createMutation = useCreateLlmProviderApiKey();
  const updateMutation = useUpdateLlmProviderApiKey();
  const { data: existingKeys = [] } = useLlmProviderApiKeys({ enabled: open });
  const byosEnabled = useFeature("byosEnabled");
  const azureOpenAiEntraIdEnabled = useFeature("azureOpenAiEntraIdEnabled");
  const anthropicWifEnabled = useFeature("anthropicWifEnabled");
  const bedrockIamAuthEnabled = useFeature("bedrockIamAuthEnabled");
  const geminiVertexAiEnabled = useFeature("geminiVertexAiEnabled");
  const { data: canCreateOrgScopedKey } = useHasPermissions({
    llmProviderApiKey: ["admin"],
  });

  const form = useForm<LlmProviderApiKeyFormValues>({
    defaultValues: getDefaultFormValues({
      defaultValues,
      canCreateOrgScopedKey: canCreateOrgScopedKey === true,
    }),
  });

  useEffect(() => {
    if (!open) return;
    form.reset(
      getDefaultFormValues({
        defaultValues,
        canCreateOrgScopedKey: canCreateOrgScopedKey === true,
      }),
    );
  }, [canCreateOrgScopedKey, defaultValues, form, open]);

  const formValues = form.watch();
  const isValid = getIsCreateFormValid({
    azureOpenAiEntraIdEnabled: azureOpenAiEntraIdEnabled === true,
    anthropicWifEnabled: anthropicWifEnabled === true,
    byosEnabled: Boolean(byosEnabled),
    values: formValues,
  });

  const createCredential = async (values: LlmProviderApiKeyFormValues) => {
    const isBedrockSigV4 =
      values.provider === "bedrock" && values.bedrockAuthMethod === "sigv4";
    try {
      await createMutation.mutateAsync({
        name:
          values.name?.trim() ||
          (values.provider === "openai" &&
          values.openaiAuthMethod === "chatgpt-subscription"
            ? CHATGPT_SUBSCRIPTION_LABEL
            : PROVIDER_CONFIG[values.provider].name),
        provider: values.provider,
        apiKey: isBedrockSigV4 ? undefined : values.apiKey || undefined,
        baseUrl: values.baseUrl || undefined,
        inferenceBaseUrl: values.inferenceBaseUrl || undefined,
        extraHeaders: serializeExtraHeaders(values.extraHeaders) ?? undefined,
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
      onSuccess?.();
    } catch {
      // Error handled by mutation
    }
  };
  const handleCreate = form.handleSubmit(createCredential);
  const handleSubscriptionCredential = (credential: string) => {
    if (reconnectKeyId) {
      // Re-authentication: rotate the existing key's secret in place — a
      // second create would leave a duplicate credential row behind, with the
      // stale one still selected in conversations.
      void (async () => {
        try {
          await updateMutation.mutateAsync({
            id: reconnectKeyId,
            data: { apiKey: credential },
          });
          onOpenChange(false);
          onSuccess?.();
        } catch {
          // Error handled by mutation
        }
      })();
      return;
    }
    const values = { ...form.getValues(), apiKey: credential };
    void createCredential(values);
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      size="small"
      className="sm:max-w-xl"
      isDirty={form.formState.isDirty}
    >
      <DialogForm
        onSubmit={handleCreate}
        className="flex min-h-0 flex-1 flex-col"
      >
        <DialogBody>
          <LlmProviderApiKeyForm
            mode="full"
            showConsoleLink={showConsoleLink}
            form={form}
            existingKeys={existingKeys}
            isPending={createMutation.isPending}
            allowedProviders={allowedProviders}
            credentialMode={credentialMode}
            progressive
            allowPersonalSubscriptions={credentialMode === "subscription"}
            onSubscriptionCredential={handleSubscriptionCredential}
            bedrockIamAuthEnabled={bedrockIamAuthEnabled}
            geminiVertexAiEnabled={geminiVertexAiEnabled}
          />
        </DialogBody>
        <DialogStickyFooter className="mt-0">
          <DialogCancelButton>Cancel</DialogCancelButton>
          {credentialMode === "api-key" && (
            <Button
              type="submit"
              disabled={!isValid || createMutation.isPending}
            >
              {createMutation.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              <span>Test & Create</span>
            </Button>
          )}
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}

function getDefaultFormValues(params: {
  defaultValues?: Partial<LlmProviderApiKeyFormValues>;
  canCreateOrgScopedKey: boolean;
}): LlmProviderApiKeyFormValues {
  const { defaultValues, canCreateOrgScopedKey } = params;
  return {
    name: "",
    provider: "anthropic",
    apiKey: null,
    baseUrl: null,
    inferenceBaseUrl: null,
    extraHeaders: [],
    scope: canCreateOrgScopedKey ? "org" : "personal",
    teamId: null,
    vaultSecretPath: null,
    vaultSecretKey: null,
    isPrimary: false,
    bedrockAuthMethod: "api-key",
    awsAccessKeyId: null,
    awsSecretAccessKey: null,
    awsSessionToken: null,
    openaiAuthMethod: "api-key",
    ...defaultValues,
  };
}

function getIsCreateFormValid(params: {
  azureOpenAiEntraIdEnabled: boolean;
  anthropicWifEnabled: boolean;
  byosEnabled: boolean;
  values: LlmProviderApiKeyFormValues;
}) {
  const {
    azureOpenAiEntraIdEnabled,
    anthropicWifEnabled,
    byosEnabled,
    values,
  } = params;

  if (values.provider === "bedrock" && values.bedrockAuthMethod === "sigv4") {
    return Boolean(
      values.awsAccessKeyId &&
        values.awsSecretAccessKey &&
        (values.scope !== "team" || values.teamId),
    );
  }

  return Boolean(
    values.apiKey !== LLM_PROVIDER_API_KEY_PLACEHOLDER &&
      (values.scope !== "team" || values.teamId) &&
      (byosEnabled
        ? values.vaultSecretPath && values.vaultSecretKey
        : isProviderApiKeyOptional({
            provider: values.provider,
            azureEntraIdEnabled: azureOpenAiEntraIdEnabled,
            anthropicWifEnabled,
          }) || values.apiKey),
  );
}
