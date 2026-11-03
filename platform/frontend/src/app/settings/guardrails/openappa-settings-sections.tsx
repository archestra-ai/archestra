"use client";

import { DocsPage, getDocsUrl, providerSupportsChat } from "@archestra/shared";
import Link from "next/link";
import { type ReactNode, useMemo, useState } from "react";
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
  useUpdateBreakTheGlass,
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
 * Break the glass: what happens to a call waiting for human approval, to a
 * call no remedy can lift (a soft block), and to a session whose agent calls
 * `yell`. One group, since together they say how much Guardrails let through.
 */
export function OpenAppaBreakTheGlassSettings() {
  const deployment = useGuardrailsDeployment({ poll: true });
  const update = useUpdateBreakTheGlass();
  const { data: canManage } = useHasPermissions({
    organizationSettings: ["update"],
  });
  const data = deployment.data;
  const disabled = !canManage || !data?.featureEnabled || update.isPending;
  return (
    <SettingsBlock
      id="break-the-glass"
      title="Break the glass"
      description="Let blocked calls through and record a yell instead of stopping the agent. Use it to see what the policy would block without blocking it."
      contentClassName="divide-y rounded-lg border"
    >
      <BreakTheGlassRow
        title="Yell tool"
        description="What a yell does to its session: the agent's own, or one for a waived call."
        value={
          data ? (data.breakTheGlassEnabled ? "off" : "record") : undefined
        }
        disabled={disabled}
        options={[
          { value: "record", label: "Record only" },
          { value: "off", label: "Record and turn Guardrails off" },
        ]}
        onChange={(value) =>
          update.mutate({ breakTheGlassEnabled: value === "off" })
        }
      />
      <BreakTheGlassRow
        title="Human approval"
        description="Calls and remedy plans waiting for human approval."
        value={data?.humanApprovalMode}
        disabled={disabled}
        environmentVariable="ARCHESTRA_OPENAPPA_HUMAN_APPROVAL_MODE"
        options={[
          { value: "block", label: "Block until approved" },
          {
            value: "unattended",
            label: "Waive in unattended sessions",
            description:
              "Agent Runtimes, Scheduled tasks, and clients sending X-Archestra-Unattended: 1. A workload's remedy plans count too.",
          },
          { value: "everywhere", label: "Waive everywhere" },
        ]}
      />
      <BreakTheGlassRow
        title="Other blocked calls"
        description={
          <>
            How to handle denials that can't be approved. Calls explicitly set
            to <code className="font-mono text-xs">blocked</code> in the policy
            will never waive.
          </>
        }
        value={data?.unapprovableBlockMode}
        disabled={disabled}
        environmentVariable="ARCHESTRA_OPENAPPA_SOFT_BLOCK_MODE"
        options={[
          { value: "refuse", label: "Keep the block" },
          { value: "allow", label: "Waive the block" },
        ]}
      />
    </SettingsBlock>
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

// ===

function BreakTheGlassRow<T extends string>(props: {
  title: string;
  description: ReactNode;
  value: T | undefined;
  disabled: boolean;
  options: { value: T; label: string; description?: string }[];
  /** Release 1.4: the deployment sets this one; the page only shows it. */
  environmentVariable?: string;
  onChange?: (value: T) => void;
}) {
  const current = props.options.find((option) => option.value === props.value);
  return (
    <div className="grid gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,20rem)] lg:items-center lg:gap-8">
      <div className="min-w-0 space-y-1">
        <h3 className="text-sm font-medium leading-5">{props.title}</h3>
        <div className="text-sm leading-5 text-muted-foreground">
          {props.description}
        </div>
      </div>
      {props.value && props.environmentVariable ? (
        <div className="min-w-0 space-y-1 lg:text-right">
          <p className="text-sm font-medium leading-5">
            {current?.label ?? props.value}
          </p>
          <p className="text-xs leading-4 text-muted-foreground">
            Set with{" "}
            <code className="font-mono">
              {/* Wrap a long name only after an underscore. */}
              {props.environmentVariable.split("_").map((part, index) => (
                <span key={`${index}-${part}`}>
                  {index > 0 ? (
                    <>
                      _<wbr />
                    </>
                  ) : null}
                  {part}
                </span>
              ))}
            </code>
          </p>
        </div>
      ) : props.value ? (
        <Select
          value={props.value}
          disabled={props.disabled}
          onValueChange={(value) => {
            const option = props.options.find((each) => each.value === value);
            if (option) props.onChange?.(option.value);
          }}
        >
          <SelectTrigger aria-label={props.title} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="end">
            {props.options.map((option) => (
              <SelectItem
                key={option.value}
                value={option.value}
                description={option.description}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Skeleton className="h-9 w-full" />
      )}
    </div>
  );
}
