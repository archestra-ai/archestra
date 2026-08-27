"use client";

import {
  isProviderApiKeyOptional,
  SUBSCRIPTION_CREDENTIALS,
  subscriptionKindForProvider,
} from "@archestra/shared";
import { Loader2 } from "lucide-react";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { FormDialog } from "@/components/form-dialog";
import {
  LLM_PROVIDER_API_KEY_PLACEHOLDER,
  LlmProviderApiKeyForm,
  type LlmProviderApiKeyFormValues,
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
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import {
  useCreateLlmProviderApiKey,
  useLlmProviderApiKeys,
  useReconnectLlmProviderApiKey,
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
  /** This dialog must connect the exact subscription kind pinned by an agent. */
  requiresExactSubscriptionCredential?: boolean;
  showConsoleLink?: boolean;
  onSuccess?: (keyId?: string) => void;
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
  requiresExactSubscriptionCredential = false,
  showConsoleLink = false,
  onSuccess,
  reconnectKeyId,
}: CreateLlmProviderApiKeyDialogProps) {
  const createMutation = useCreateLlmProviderApiKey();
  const reconnectMutation = useReconnectLlmProviderApiKey();
  const { data: existingKeys = [] } = useLlmProviderApiKeys({ enabled: open });
  const byosEnabled = useFeature("byosEnabled");
  const azureOpenAiEntraIdEnabled = useFeature("azureOpenAiEntraIdEnabled");
  const anthropicWifEnabled = useFeature("anthropicWifEnabled");
  const bedrockIamAuthEnabled = useFeature("bedrockIamAuthEnabled");
  const geminiVertexAiEnabled = useFeature("geminiVertexAiEnabled");
  const { data: canCreateOrgScopedKey } = useHasPermissions({
    llmProviderApiKey: ["admin"],
  });
  const providerCatalog = useModelProviderCatalog();

  const form = useForm<LlmProviderApiKeyFormValues>({
    defaultValues: getDefaultFormValues({
      defaultValues,
      canCreateOrgScopedKey: canCreateOrgScopedKey === true,
      availableProviders: providerCatalog.visibleIds,
    }),
  });

  useEffect(() => {
    if (!open) return;
    form.reset(
      getDefaultFormValues({
        defaultValues,
        canCreateOrgScopedKey: canCreateOrgScopedKey === true,
        availableProviders: providerCatalog.visibleIds,
      }),
    );
  }, [canCreateOrgScopedKey, defaultValues, form, open, providerCatalog]);

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
    // A subscription key defaults to the subscription's own name rather than the
    // provider's, so an unnamed ChatGPT key isn't just called "OpenAI".
    const subscriptionKind =
      values.authMethod === "subscription"
        ? subscriptionKindForProvider(values.provider)
        : null;
    // Subscription credentials are per-user, so the key is always personal.
    // Resolved here rather than via the form's scope coercion: that coercion is
    // deferred until a sign-in completes (so switching tabs can't silently
    // privatize anything), and the sign-in callback reads form values in the
    // same tick the credential lands — before any effect has run.
    const scope = subscriptionKind ? "personal" : values.scope;
    try {
      const createdKey = await createMutation.mutateAsync({
        name:
          values.name?.trim() ||
          (subscriptionKind
            ? SUBSCRIPTION_CREDENTIALS[subscriptionKind].label
            : providerCatalog.label(values.provider)),
        provider: values.provider,
        apiKey: isBedrockSigV4 ? undefined : values.apiKey || undefined,
        baseUrl: values.baseUrl || undefined,
        inferenceBaseUrl: values.inferenceBaseUrl || undefined,
        extraHeaders: serializeExtraHeaders(values.extraHeaders) ?? undefined,
        scope,
        teamId: scope === "team" && values.teamId ? values.teamId : undefined,
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
      onSuccess?.(createdKey?.id);
      return true;
    } catch {
      // Error handled by mutation
      return false;
    }
  };
  const handleCreate = form.handleSubmit(createCredential);
  const handleSubscriptionCredential = async (credential: string) => {
    if (reconnectKeyId) {
      // Re-authentication: rotate the existing key's secret in place — a
      // second create would leave a duplicate credential row behind, with the
      // stale one still selected in conversations. Uses the self-service
      // reconnect endpoint rather than the permission-gated PATCH, so default
      // members can refresh their own expired sign-in.
      const reconnectedKey = await reconnectMutation.mutateAsync({
        id: reconnectKeyId,
        apiKey: credential,
      });
      onOpenChange(false);
      onSuccess?.(reconnectedKey?.id ?? reconnectKeyId);
      return;
    }
    const values = { ...form.getValues(), apiKey: credential };
    const created = await createCredential(values);
    if (!created) {
      throw new Error("Subscription credential was not saved");
    }
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
            requiresExactSubscriptionCredential={
              requiresExactSubscriptionCredential
            }
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
  /** Providers the organization still allows, in catalog order. */
  availableProviders: LlmProviderApiKeyFormValues["provider"][];
}): LlmProviderApiKeyFormValues {
  const { defaultValues, canCreateOrgScopedKey, availableProviders } = params;
  return {
    name: "",
    // Anthropic unless the admins turned it off — the dialog must never open
    // on a provider its own picker refuses to offer.
    provider: availableProviders.includes("anthropic")
      ? "anthropic"
      : (availableProviders[0] ?? "anthropic"),
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
    authMethod: "api-key",
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
