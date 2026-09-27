"use client";

import {
  isProviderApiKeyOptional,
  providerRequiresPerUserCredential,
  SUBSCRIPTION_CREDENTIALS,
  subscriptionKindForProvider,
} from "@archestra/shared";
import { KeyRound, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import type { ProfileLabel, ProfileLabelsRef } from "@/components/agent-labels";
import { ConnectionSignInDialog } from "@/components/connection-sign-in-dialog";
import { FormDialog } from "@/components/form-dialog";
import {
  LLM_PROVIDER_API_KEY_PLACEHOLDER,
  LlmProviderApiKeyForm,
  type LlmProviderApiKeyFormValues,
  serializeExtraHeaders,
} from "@/components/llm-provider-api-key-form";
import { ResourceAccessSection } from "@/components/resource-access-section";
import { TabbedDialogShell } from "@/components/tabbed-dialog-shell";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { useFeature } from "@/lib/config/config.query";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import {
  type LlmProviderApiKey,
  useCreateLlmProviderApiKey,
  useLlmProviderApiKeys,
  useReconnectLlmProviderApiKey,
} from "@/lib/llm-provider-api-keys.query";

const EMPTY_EXISTING_KEYS: LlmProviderApiKey[] = [];

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
  const { data: existingKeys } = useLlmProviderApiKeys({ enabled: open });
  const byosEnabled = useFeature("byosEnabled");
  const azureOpenAiEntraIdEnabled = useFeature("azureOpenAiEntraIdEnabled");
  const anthropicKeylessAuthEnabled = useFeature("anthropicKeylessAuthEnabled");
  const bedrockIamAuthEnabled = useFeature("bedrockIamAuthEnabled");
  const geminiVertexAiEnabled = useFeature("geminiVertexAiEnabled");
  const providerCatalog = useModelProviderCatalog();
  const [labels, setLabels] = useState<ProfileLabel[]>([]);
  const [activeSection, setActiveSection] = useState<"general" | "permissions">(
    "general",
  );
  const labelsRef = useRef<ProfileLabelsRef>(null);
  const lastResetKeyRef = useRef<string | null>(null);
  const visibleProviderIdsKey = providerCatalog.visibleIds.join(",");
  const allowedProviderIdsKey = allowedProviders?.join(",") ?? null;
  const availableProviders = useMemo(() => {
    const visibleProviders = visibleProviderIdsKey
      ? (visibleProviderIdsKey.split(
          ",",
        ) as LlmProviderApiKeyFormValues["provider"][])
      : [];
    const allowedProviderIds = allowedProviderIdsKey
      ? (allowedProviderIdsKey.split(
          ",",
        ) as LlmProviderApiKeyFormValues["provider"][])
      : visibleProviders;
    const visibleProviderSet = new Set(visibleProviders);
    return allowedProviderIds.filter((provider) =>
      visibleProviderSet.has(provider),
    );
  }, [allowedProviderIdsKey, visibleProviderIdsKey]);
  const onlyAvailableProvider =
    availableProviders.length === 1 ? availableProviders[0] : undefined;
  const dialogTitle =
    title === "Add API Key" && onlyAvailableProvider
      ? `Add ${providerCatalog.label(onlyAvailableProvider)} API Key`
      : title;
  const defaultFormValues = useMemo(
    () =>
      availableProviders.length > 0
        ? getDefaultFormValues({
            defaultValues,
            availableProviders,
          })
        : null,
    [availableProviders, defaultValues],
  );
  const resetKey = JSON.stringify(defaultFormValues);

  const form = useForm<LlmProviderApiKeyFormValues>({
    defaultValues: defaultFormValues ?? undefined,
  });

  useEffect(() => {
    if (!open) {
      lastResetKeyRef.current = null;
      return;
    }
    if (!defaultFormValues || lastResetKeyRef.current === resetKey) return;

    lastResetKeyRef.current = resetKey;
    setActiveSection("general");
    setLabels([]);
    form.reset(defaultFormValues);
  }, [defaultFormValues, form, open, resetKey]);

  const formValues = form.watch();
  const isValid =
    availableProviders.length > 0 &&
    getIsCreateFormValid({
      azureOpenAiEntraIdEnabled: azureOpenAiEntraIdEnabled === true,
      anthropicKeylessAuthEnabled: anthropicKeylessAuthEnabled === true,
      byosEnabled: Boolean(byosEnabled),
      values: formValues,
    });

  const createCredential = async (values: LlmProviderApiKeyFormValues) => {
    const finalLabels = labelsRef.current?.saveUnsavedLabel() ?? labels;
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
    const shared = subscriptionKind ? false : values.shared;
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
        shared,
        // SPDX-SnippetBegin
        // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        initialGrants:
          !shared ||
          subscriptionKind ||
          providerRequiresPerUserCredential(values.provider)
            ? []
            : (values.initialGrants ?? []).map(
                ({ name: _name, ...grant }) => grant,
              ),
        // SPDX-SnippetEnd
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
        labels: finalLabels,
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

  if (availableProviders.length === 0) {
    return (
      <FormDialog
        open={open}
        onOpenChange={onOpenChange}
        title={dialogTitle}
        description={description}
        size="small"
        className="sm:max-w-xl"
      >
        <DialogBody>
          <p>No compatible LLM providers are enabled for this agent.</p>
        </DialogBody>
        <DialogStickyFooter className="mt-0">
          <DialogCancelButton>Cancel</DialogCancelButton>
        </DialogStickyFooter>
      </FormDialog>
    );
  }

  const keyForm = (
    <LlmProviderApiKeyForm
      mode="full"
      showConsoleLink={showConsoleLink}
      form={form}
      existingKeys={existingKeys ?? EMPTY_EXISTING_KEYS}
      isPending={createMutation.isPending}
      allowedProviders={availableProviders}
      hideUnavailableProviders
      credentialMode={credentialMode}
      requiresExactSubscriptionCredential={requiresExactSubscriptionCredential}
      progressive
      allowPersonalSubscriptions={credentialMode === "subscription"}
      onSubscriptionCredential={handleSubscriptionCredential}
      bedrockIamAuthEnabled={bedrockIamAuthEnabled}
      geminiVertexAiEnabled={geminiVertexAiEnabled}
      labels={reconnectKeyId ? undefined : labels}
      onLabelsChange={reconnectKeyId ? undefined : setLabels}
      labelsRef={reconnectKeyId ? undefined : labelsRef}
      hidePermissions
    />
  );

  if (credentialMode === "subscription") {
    return (
      <ConnectionSignInDialog
        open={open}
        onOpenChange={onOpenChange}
        title={dialogTitle}
        description={description}
        action={keyForm}
      />
    );
  }

  return (
    <TabbedDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={dialogTitle}
      description={description}
      sidebarLabel={form.watch("name") || "New provider key"}
      sidebarDescription="Model provider"
      sidebarIcon={<KeyRound className="h-4 w-4 text-muted-foreground" />}
      activeSection={activeSection}
      navItems={
        form.watch("shared")
          ? [
              { id: "general", label: "General" },
              { id: "permissions", label: "Permissions" },
            ]
          : [{ id: "general", label: "General" }]
      }
      onActiveSectionChange={setActiveSection}
      onSubmit={handleCreate}
      footer={
        <>
          <DialogCancelButton>Cancel</DialogCancelButton>
          <Button type="submit" disabled={!isValid || createMutation.isPending}>
            {createMutation.isPending && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            <span>Test & Create</span>
          </Button>
        </>
      }
      isDirty={credentialMode === "api-key" && form.formState.isDirty}
    >
      <div hidden={activeSection !== "general"}>{keyForm}</div>
      {form.watch("shared") && (
        <div hidden={activeSection !== "permissions"}>
          {/* SPDX-SnippetBegin
            SPDX-SnippetCopyrightText: 2026 Archestra Inc.
            SPDX-License-Identifier: LicenseRef-Archestra-Enterprise */}
          <ResourceAccessSection
            resource="llmProviderApiKey"
            grants={form.watch("initialGrants") ?? []}
            onGrantsChange={(grants) =>
              form.setValue("initialGrants", grants, { shouldDirty: true })
            }
            standalone
          />
          {/* SPDX-SnippetEnd */}
        </div>
      )}
    </TabbedDialogShell>
  );
}

function getDefaultFormValues(params: {
  defaultValues?: Partial<LlmProviderApiKeyFormValues>;
  /** Providers the organization still allows, in catalog order. */
  availableProviders: LlmProviderApiKeyFormValues["provider"][];
}): LlmProviderApiKeyFormValues {
  const { defaultValues, availableProviders } = params;
  const provider =
    defaultValues?.provider &&
    availableProviders.includes(defaultValues.provider)
      ? defaultValues.provider
      : availableProviders.includes("anthropic")
        ? "anthropic"
        : availableProviders[0];
  return {
    name: "",
    apiKey: null,
    baseUrl: null,
    inferenceBaseUrl: null,
    extraHeaders: [],
    shared: false,
    initialGrants: [],
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
    // Anthropic unless the compatible provider list excludes it.
    provider,
  };
}

function getIsCreateFormValid(params: {
  azureOpenAiEntraIdEnabled: boolean;
  anthropicKeylessAuthEnabled: boolean;
  byosEnabled: boolean;
  values: LlmProviderApiKeyFormValues;
}) {
  const {
    azureOpenAiEntraIdEnabled,
    anthropicKeylessAuthEnabled,
    byosEnabled,
    values,
  } = params;

  if (values.provider === "bedrock" && values.bedrockAuthMethod === "sigv4") {
    return Boolean(values.awsAccessKeyId && values.awsSecretAccessKey);
  }

  return Boolean(
    values.apiKey !== LLM_PROVIDER_API_KEY_PLACEHOLDER &&
      (byosEnabled
        ? values.vaultSecretPath && values.vaultSecretKey
        : isProviderApiKeyOptional({
            provider: values.provider,
            azureEntraIdEnabled: azureOpenAiEntraIdEnabled,
            anthropicKeylessAuthEnabled,
          }) || values.apiKey),
  );
}
