"use client";

import { DocsPage, getDocsUrl, providerSupportsChat } from "@archestra/shared";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useOpenAppaSetupState } from "@/app/openappa/_parts/use-openappa-setup-state";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { LlmModelSearchableSelect } from "@/components/llm-model-select";
import { LlmProviderApiKeyDropdown } from "@/components/llm-provider-api-key-dropdown";
import { SettingsBlock } from "@/components/settings/settings-block";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { getVisibleDocsUrl } from "@/lib/docs/docs";
import {
  useGuardrailsDeployment,
  useUpdateAnnotatorModel,
  useUpdateBreakTheGlassEnabled,
  useUpdateGuardrailsDeployment,
  useUpdateUnsupportedClientAction,
} from "@/lib/guardrails-deployment.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { isPersonalSubscription } from "@/lib/llm-key-subscription";
import { useLlmModels } from "@/lib/llm-models.query";
import { useAvailableLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";

/** Whether tool calls are checked against the policy at all. */
export function OpenAppaEnforcementSetting() {
  const deployment = useGuardrailsDeployment({ poll: true });
  const update = useUpdateGuardrailsDeployment();
  const { data: canManage } = useHasPermissions({
    organizationSettings: ["update"],
  });
  const { isFresh } = useOpenAppaSetupState();
  const enabled = Boolean(deployment.data?.enabled);
  return (
    <SettingsBlock
      id="enforcement"
      title="Enforce the policy"
      description={
        enabled ? (
          "Guardrails are on. Every tool call is checked against your policy before it runs."
        ) : isFresh ? (
          // Saving the first policy turns enforcement on; there is nothing to enforce before it.
          <>
            <span>There is no policy yet. </span>
            <Link
              href="/openappa"
              className="text-primary underline underline-offset-2 hover:text-primary/80"
            >
              Create your policy
            </Link>
            <span> to turn this on.</span>
          </>
        ) : (
          "Guardrails are off. Your policy isn't applied, so agents can call any tool."
        )
      }
      control={
        deployment.data ? (
          <Switch
            aria-label="Enforce the policy"
            checked={enabled}
            disabled={
              !canManage ||
              !deployment.data.featureEnabled ||
              isFresh !== false ||
              update.isPending
            }
            onCheckedChange={(checked) => update.mutate(checked)}
          />
        ) : (
          <Skeleton className="h-5 w-9 rounded-full" />
        )
      }
    />
  );
}

/**
 * Whether a yell also turns OpenAPPA off for the session that sends it, so a
 * stuck agent can get unblocked.
 */
export function OpenAppaBreakTheGlassSetting() {
  const deployment = useGuardrailsDeployment({ poll: true });
  const update = useUpdateBreakTheGlassEnabled();
  const { data: canManage } = useHasPermissions({
    organizationSettings: ["update"],
  });
  const enabled = Boolean(deployment.data?.breakTheGlassEnabled);
  return (
    <SettingsBlock
      id="break-the-glass"
      title="Break the glass"
      description={
        enabled
          ? "A yell will disable guardrails for the session, unblocking your stuck agents."
          : "A yell only sends a report. Guardrails stay on for the session."
      }
      control={
        deployment.data ? (
          <Switch
            aria-label="Break the glass"
            checked={enabled}
            disabled={
              !canManage || !deployment.data.featureEnabled || update.isPending
            }
            onCheckedChange={(checked) => update.mutate(checked)}
          />
        ) : (
          <Skeleton className="h-5 w-9 rounded-full" />
        )
      }
    />
  );
}

/**
 * The model OpenAPPA's model annotators answer with, such as the default
 * policy's catch-all for tool calls no rule annotates. Unset, they use the
 * organization's default model. A key alone is not saved: the setting is
 * stored once a model is picked for it.
 */
export function OpenAppaAnnotatorModelSetting() {
  const deployment = useGuardrailsDeployment({ poll: true });
  const update = useUpdateAnnotatorModel();
  const { data: canManage } = useHasPermissions({
    organizationSettings: ["update"],
  });
  const { data: apiKeys } = useAvailableLlmProviderApiKeys({
    toastOnError: false,
  });
  const [keySelectorOpen, setKeySelectorOpen] = useState(false);
  // A key picked here but not yet saved with a model; undefined follows the
  // saved setting.
  const [pendingKeyId, setPendingKeyId] = useState<string | null>();
  const savedKeyId = deployment.data?.annotatorLlmApiKeyId ?? null;
  const keyId = pendingKeyId !== undefined ? pendingKeyId : savedKeyId;
  const modelId =
    pendingKeyId !== undefined ? "" : (deployment.data?.annotatorModelId ?? "");
  const {
    data: models,
    isPending: modelsLoading,
    isPlaceholderData,
  } = useLlmModels({ apiKeyId: keyId ?? undefined });
  // Annotators run for whoever's session is checked, so a personal
  // subscription, which only its owner may use, is never offered.
  const availableKeys = useMemo(
    () =>
      (apiKeys ?? []).filter(
        (key) =>
          providerSupportsChat(key.provider) && !isPersonalSubscription(key),
      ),
    [apiKeys],
  );
  const modelItems = useMemo(
    () =>
      !keyId || !models || isPlaceholderData
        ? []
        : models.map((model) => ({
            value: model.dbId,
            model: model.displayName ?? model.id,
            modelId: model.id,
            provider: model.provider,
            isFree: model.isFree,
            isBest: model.isBest,
          })),
    [keyId, models, isPlaceholderData],
  );
  const disabled =
    !canManage || !deployment.data?.featureEnabled || update.isPending;
  const save = (selection: {
    annotatorModelId: string | null;
    annotatorLlmApiKeyId: string | null;
  }) =>
    update.mutate(selection, {
      onSuccess: () => setPendingKeyId(undefined),
    });
  return (
    <SettingsBlock
      id="annotator-model"
      title="Annotator model"
      description={
        <>
          <span className="block">
            Sets the trust and audience of tool calls your policy has no rule
            for. For example, a call that reads a secrets file becomes visible
            only to the person running the session.
          </span>
          <span className="mt-2 block">
            It answers the{" "}
            <code className="font-mono text-xs">archestra.llm-annotator</code>{" "}
            annotator, which the starting policy applies to every tool you
            haven't annotated yourself. Unless you pick a model, it uses the
            organization's default.
          </span>
          <span className="mt-2 block">
            We recommend a model from the Sonnet or Luna family.
          </span>
        </>
      }
      control={
        deployment.data ? (
          <div className="flex w-full flex-col gap-2 sm:w-80">
            <LlmProviderApiKeyDropdown
              availableKeys={availableKeys}
              selectedApiKeyId={keyId}
              disabled={disabled}
              open={keySelectorOpen}
              onOpenChange={setKeySelectorOpen}
              onSelectKey={(value) => {
                setPendingKeyId(value === savedKeyId ? undefined : value);
                setKeySelectorOpen(false);
              }}
              allowOrganizationDefault
              organizationDefaultSelected={!keyId}
              onSelectOrganizationDefault={() => {
                setKeySelectorOpen(false);
                if (savedKeyId)
                  save({ annotatorModelId: null, annotatorLlmApiKeyId: null });
                else setPendingKeyId(undefined);
              }}
              triggerVariant="select"
              triggerAriaLabel="Annotator provider key"
              triggerClassName="w-full"
              popoverClassName="w-80"
            />
            {keyId ? (
              <LlmModelSearchableSelect
                value={modelId}
                onValueChange={(value) =>
                  save({ annotatorModelId: value, annotatorLlmApiKeyId: keyId })
                }
                options={modelItems}
                placeholder={
                  modelsLoading || isPlaceholderData
                    ? "Loading models..."
                    : "Select model..."
                }
                className="w-full"
                disabled={disabled || modelsLoading || isPlaceholderData}
              />
            ) : null}
          </div>
        ) : (
          <Skeleton className="h-9 w-80" />
        )
      }
    />
  );
}

/**
 * What the proxy does with a request the guardrail cannot follow: one from a
 * client with no built-in support that sends no OpenAPPA session headers.
 */
export function OpenAppaClientCoverageSetting() {
  const deployment = useGuardrailsDeployment({ poll: true });
  const update = useUpdateUnsupportedClientAction();
  const { data: canManage } = useHasPermissions({
    organizationSettings: ["update"],
  });
  const appName = useAppName();
  return (
    <SettingsBlock
      id="client-coverage"
      title="Other clients"
      description={
        <>
          <span>
            Guardrails follow {appName} chat, Claude Code, Codex, and{" "}
          </span>
          <ClientsDocsLink>more</ClientsDocsLink>
          <span>, plus any client that sends </span>
          <ClientsDocsLink anchor="session-headers">
            OpenAPPA session headers
          </ClientsDocsLink>
          <span>. Requests from any other client are:</span>
        </>
      }
      control={
        deployment.data ? (
          <Select
            value={deployment.data.unsupportedClientAction}
            disabled={
              !canManage || !deployment.data.featureEnabled || update.isPending
            }
            onValueChange={(value) => {
              if (value === "bypass" || value === "block") update.mutate(value);
            }}
          >
            <SelectTrigger
              aria-label="Requests from other clients"
              className="w-full lg:w-48"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              <SelectItem
                value="bypass"
                description="Their model calls work, but guardrails don't check them."
              >
                Allowed
              </SelectItem>
              <SelectItem
                value="block"
                description="Their model calls fail with an error saying how to add support."
              >
                Blocked
              </SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <Skeleton className="h-9 w-48" />
        )
      }
    />
  );
}

/**
 * A docs link inside a sentence. A white-labeled deployment hides public docs
 * links; the words then stay as plain text so the sentence still reads whole.
 */
function ClientsDocsLink({
  anchor,
  children,
}: {
  anchor?: string;
  children: string;
}) {
  const href = getVisibleDocsUrl(
    getDocsUrl(DocsPage.PlatformAiToolGuardrailsClients, anchor),
  );
  if (!href) return <span>{children}</span>;
  return (
    <ExternalDocsLink
      href={href}
      showIcon={false}
      className="text-primary underline underline-offset-2 hover:text-primary/80"
    >
      {children}
    </ExternalDocsLink>
  );
}
