"use client";

import {
  CHATGPT_SUBSCRIPTION_LABEL,
  E2eTestId,
  isProviderApiKeyOptional,
  providerRequiresPerUserCredential,
  SupportedProviders,
} from "@archestra/shared";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { FormDialog } from "@/components/form-dialog";
import {
  isBaseUrlRequiredForProvider,
  LLM_PROVIDER_API_KEY_PLACEHOLDER,
  LlmProviderApiKeyForm,
  type LlmProviderApiKeyFormValues,
  PROVIDER_CONFIG,
  type ProviderBaseUrls,
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
import { useFeature, useProviderBaseUrls } from "@/lib/config/config.query";
import { useLlmModels } from "@/lib/llm-models.query";
import {
  useCreateLlmProviderApiKey,
  useLlmProviderApiKeys,
} from "@/lib/llm-provider-api-keys.query";

/**
 * Providers offered in the paste-a-key create flow: everything except the
 * per-user subscription providers (GitHub Copilot, Microsoft 365 Copilot), which
 * have no key to paste and live in the "Use a subscription" dialog instead.
 */
const CREATE_ALLOWED_PROVIDERS = SupportedProviders.filter(
  (provider) => !providerRequiresPerUserCredential(provider),
);

export type CreateLlmProviderApiKeyDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  defaultValues?: Partial<LlmProviderApiKeyFormValues>;
  /** Restrict the provider picker to this allowlist (e.g. the providers the
   * selected connect client can actually route). Omit to allow all providers. */
  allowedProviders?: LlmProviderApiKeyFormValues["provider"][];
  showConsoleLink?: boolean;
  onSuccess?: () => void;
  /**
   * When provided, selecting OpenAI shows a "use a subscription instead" action.
   * Invoking it closes this dialog and calls back so the parent can open the Use
   * Subscription dialog.
   */
  onUseSubscription?: () => void;
};

export function CreateLlmProviderApiKeyDialog({
  open,
  onOpenChange,
  title,
  description,
  defaultValues,
  allowedProviders,
  showConsoleLink = false,
  onSuccess,
  onUseSubscription,
}: CreateLlmProviderApiKeyDialogProps) {
  const createMutation = useCreateLlmProviderApiKey();
  const { data: existingKeys = [] } = useLlmProviderApiKeys({ enabled: open });
  const { data: providerBaseUrls } = useProviderBaseUrls();
  const byosEnabled = useFeature("byosEnabled");
  const azureOpenAiEntraIdEnabled = useFeature("azureOpenAiEntraIdEnabled");
  const anthropicWifEnabled = useFeature("anthropicWifEnabled");
  const bedrockIamAuthEnabled = useFeature("bedrockIamAuthEnabled");
  const geminiVertexAiEnabled = useFeature("geminiVertexAiEnabled");
  const { data: canCreateOrgScopedKey } = useHasPermissions({
    llmProviderApiKey: ["admin"],
  });

  // After a successful create, the dialog stays open on a confirmation view that
  // fetches the just-added provider's models — proof the key works, not just that
  // it saved. Cleared whenever the dialog closes.
  const [createdKey, setCreatedKey] = useState<{ id: string } | null>(null);

  const form = useForm<LlmProviderApiKeyFormValues>({
    defaultValues: getDefaultFormValues({
      defaultValues,
      canCreateOrgScopedKey: canCreateOrgScopedKey === true,
    }),
  });

  useEffect(() => {
    if (!open) return;
    setCreatedKey(null);
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
    providerBaseUrls,
    values: formValues,
  });

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      // Any close path (Done, the X button, Escape, outside click) while the
      // post-create confirmation is showing means the key was already
      // created — report success exactly once, regardless of how the dialog
      // was dismissed.
      if (createdKey) onSuccess?.();
      setCreatedKey(null);
    }
    onOpenChange(nextOpen);
  };

  const handleDone = () => handleOpenChange(false);

  // Close this dialog, then let the parent open the Use Subscription dialog.
  const handleSwitchToSubscription = onUseSubscription
    ? () => {
        handleOpenChange(false);
        onUseSubscription();
      }
    : undefined;

  const handleCreate = form.handleSubmit(async (values) => {
    const isBedrockSigV4 =
      values.provider === "bedrock" && values.bedrockAuthMethod === "sigv4";
    try {
      const created = await createMutation.mutateAsync({
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
      // Show the model-list confirmation instead of closing immediately.
      if (created) setCreatedKey({ id: created.id });
    } catch {
      // Error handled by mutation
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={title}
      description={description}
      size="small"
      className="sm:max-w-xl"
      // Once the key is created, dropping the (now-saved) form data is harmless,
      // so don't guard the confirmation view behind a discard prompt.
      isDirty={form.formState.isDirty && !createdKey}
    >
      {createdKey ? (
        <>
          <DialogBody
            data-testid={E2eTestId.AddApiKeyConnectedModels}
            className="space-y-3"
          >
            <div className="flex items-center gap-2 text-sm font-medium text-green-600 dark:text-green-400">
              <CheckCircle2 className="h-5 w-5" />
              Connected — key verified
            </div>
            <ConnectedModelsSummary apiKeyId={createdKey.id} />
          </DialogBody>
          <DialogStickyFooter className="mt-0">
            <Button
              type="button"
              onClick={handleDone}
              data-testid={E2eTestId.AddApiKeyDoneButton}
            >
              Done
            </Button>
          </DialogStickyFooter>
        </>
      ) : (
        <DialogForm
          onSubmit={handleCreate}
          className="flex min-h-0 flex-1 flex-col"
        >
          <DialogBody>
            <LlmProviderApiKeyForm
              mode="full"
              variant="onboarding"
              showConsoleLink={showConsoleLink}
              form={form}
              existingKeys={existingKeys}
              isPending={createMutation.isPending}
              allowedProviders={allowedProviders ?? CREATE_ALLOWED_PROVIDERS}
              bedrockIamAuthEnabled={bedrockIamAuthEnabled}
              geminiVertexAiEnabled={geminiVertexAiEnabled}
              onUseSubscription={handleSwitchToSubscription}
            />
          </DialogBody>
          <DialogStickyFooter className="mt-0">
            <DialogCancelButton>Cancel</DialogCancelButton>
            <Button
              type="submit"
              disabled={!isValid || createMutation.isPending}
            >
              {createMutation.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              Test & Create
            </Button>
          </DialogStickyFooter>
        </DialogForm>
      )}
    </FormDialog>
  );
}

/**
 * Confirmation panel shown after a key is created: fetches the models the new
 * provider key exposes so the user sees it actually works before landing in chat.
 */
function ConnectedModelsSummary({ apiKeyId }: { apiKeyId: string }) {
  const { data: models = [], isPending } = useLlmModels({
    apiKeyId,
    enabled: true,
  });

  if (isPending) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading available models…
      </p>
    );
  }

  if (models.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No models returned yet — they may still be syncing. You can start
        chatting once they appear.
      </p>
    );
  }

  return (
    <div className="space-y-1.5">
      <p className="text-sm text-muted-foreground">
        {models.length} model{models.length === 1 ? "" : "s"} available:
      </p>
      <div className="flex flex-wrap gap-1.5">
        {models.slice(0, 12).map((model) => (
          <span
            key={model.dbId}
            className="rounded border bg-muted/40 px-2 py-0.5 text-xs"
          >
            {model.displayName ?? model.id}
          </span>
        ))}
        {models.length > 12 && (
          <span className="px-2 py-0.5 text-xs text-muted-foreground">
            +{models.length - 12} more
          </span>
        )}
      </div>
    </div>
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
  providerBaseUrls: ProviderBaseUrls;
  values: LlmProviderApiKeyFormValues;
}) {
  const {
    azureOpenAiEntraIdEnabled,
    anthropicWifEnabled,
    byosEnabled,
    providerBaseUrls,
    values,
  } = params;

  // Mirrors the form field's own validator: a required Base URL can be folded
  // into the collapsed Advanced settings accordion, so the button must stay
  // disabled until it is filled rather than let the submit silently block on
  // a field the user can't see.
  const baseUrlOk =
    !isBaseUrlRequiredForProvider({
      provider: values.provider,
      providerBaseUrls,
    }) || Boolean(values.baseUrl);

  if (values.provider === "bedrock" && values.bedrockAuthMethod === "sigv4") {
    return Boolean(
      baseUrlOk &&
        values.awsAccessKeyId &&
        values.awsSecretAccessKey &&
        (values.scope !== "team" || values.teamId),
    );
  }

  return Boolean(
    baseUrlOk &&
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
