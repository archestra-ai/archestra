"use client";

import { DocsPage, getDocsUrl, providerSupportsChat } from "@archestra/shared";
import { Info } from "lucide-react";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
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
import { cn } from "@/lib/utils/tailwind";

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
 * Break the glass, in display order: what a yell does to its session (Yell
 * tool), what happens to a call waiting for human approval (Human approval),
 * and to a blocked call without an approval option (Other blocked calls).
 * One group, since together they say how much Guardrails let through.
 */
export function OpenAppaBreakTheGlassSettings() {
  const deployment = useGuardrailsDeployment({ poll: true });
  const update = useUpdateBreakTheGlass();
  const { data: canManage } = useHasPermissions({
    organizationSettings: ["update"],
  });
  const data = deployment.data;
  const disabled = !canManage || !data?.featureEnabled || update.isPending;
  const overriddenBy = (
    setting: "humanApprovalMode" | "unapprovableBlockMode",
  ) =>
    data?.environmentOverrides?.find((each) => each.setting === setting)
      ?.variable;
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
        environmentVariable={overriddenBy("humanApprovalMode")}
        disabled={disabled}
        options={[
          {
            value: "block",
            label: "Block until approved",
            description: "Require human approval in every session.",
          },
          {
            value: "unattended",
            label: "Waive in unattended sessions",
            description:
              "Agent Runtimes, Scheduled tasks, and clients sending X-Archestra-Unattended: 1. A workload's remedy plans count too.",
          },
          {
            value: "everywhere",
            label: "Waive everywhere",
            description: "Waive human approval in all sessions.",
          },
        ]}
        onChange={(humanApprovalMode) => update.mutate({ humanApprovalMode })}
      />
      <BreakTheGlassRow
        title="Other blocked calls"
        description={
          <>
            How to handle denials that can't be approved. An explicit
            <code className="font-mono text-xs"> blocked </code> refusal cannot
            trigger a waiver. After a soft refusal turns Guardrails off,
            subsequent operations bypass all policy checks.
          </>
        }
        value={data?.unapprovableBlockMode}
        environmentVariable={overriddenBy("unapprovableBlockMode")}
        disabled={disabled}
        options={[
          {
            value: "refuse",
            label: "Keep the block",
            description: "Refuse operations that cannot be approved.",
          },
          {
            value: "allow",
            label: "Waive the block",
            description:
              "Continue and turn Guardrails off for the session. Subsequent operations bypass all policy checks, including explicit blocked marks.",
          },
        ]}
        onChange={(unapprovableBlockMode) =>
          update.mutate({ unapprovableBlockMode })
        }
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
            haven't annotated yourself. Unless you pick a model, it uses a fast
            model, such as Claude Haiku or GPT Luna, on the key of the
            organization's default model, or that default model when the key
            serves no fast model.
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
  /** The environment variable that sets this setting, while one does. */
  environmentVariable?: string;
  onChange: (value: T) => void;
}) {
  const noteId = `${props.title.replaceAll(" ", "-").toLowerCase()}-env-note`;
  return (
    <div
      className={cn(
        "grid gap-3 p-4 lg:items-center lg:gap-8",
        props.environmentVariable
          ? "lg:grid-cols-[minmax(0,1fr)_max-content]"
          : "lg:grid-cols-[minmax(0,1fr)_minmax(16rem,20rem)]",
      )}
    >
      <div className="min-w-0 space-y-1">
        <h3 className="text-sm font-medium leading-5">{props.title}</h3>
        <div className="text-sm leading-5 text-muted-foreground">
          {props.description}
        </div>
      </div>
      {props.value ? (
        <div className="min-w-0 space-y-1.5">
          <Select
            value={props.value}
            disabled={props.disabled || props.environmentVariable !== undefined}
            onValueChange={(value) => {
              const option = props.options.find((each) => each.value === value);
              if (option) props.onChange(option.value);
            }}
          >
            <SelectTrigger
              aria-label={props.title}
              aria-describedby={props.environmentVariable ? noteId : undefined}
              className="w-full"
            >
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
          {props.environmentVariable ? (
            <div className="space-y-1 text-xs leading-4 text-muted-foreground">
              <p className="lg:whitespace-nowrap">
                <span>Set with </span>
                <code className="font-mono">
                  {/* Wrap a long name only after an underscore. */}
                  {props.environmentVariable.split("_").map((part, index) => (
                    <span key={part}>
                      {index > 0 ? (
                        <>
                          _<wbr />
                        </>
                      ) : null}
                      {part}
                    </span>
                  ))}
                  <span>={props.value}</span>
                </code>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <UnstyledButton
                      aria-label={`${props.title} environment values`}
                      className="ml-1 inline-flex align-middle"
                    >
                      <Info className="size-3.5" />
                    </UnstyledButton>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-sm space-y-2" align="end">
                    {props.options.map((option) => (
                      <div key={option.value}>
                        <code className="font-mono">{option.value}</code>
                        <span> — {option.label}.</span>
                        {option.description ? (
                          <p className="mt-1">{option.description}</p>
                        ) : null}
                      </div>
                    ))}
                  </TooltipContent>
                </Tooltip>
              </p>
              <p id={noteId}>
                Unset the environment variable to edit this setting.
              </p>
            </div>
          ) : null}
        </div>
      ) : (
        <Skeleton className="h-9 w-full" />
      )}
    </div>
  );
}
