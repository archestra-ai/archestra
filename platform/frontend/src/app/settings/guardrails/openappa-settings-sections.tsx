"use client";

import { DocsPage, getDocsUrl, providerSupportsChat } from "@archestra/shared";
import { X } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useOpenAppaSetupState } from "@/app/openappa/_parts/use-openappa-setup-state";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { LlmModelSearchableSelect } from "@/components/llm-model-select";
import { LlmProviderApiKeyDropdown } from "@/components/llm-provider-api-key-dropdown";
import { SettingsBlock } from "@/components/settings/settings-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { getVisibleDocsUrl } from "@/lib/docs/docs";
import {
  type GuardrailsMode,
  type PersonApproval,
  useGuardrailsDeployment,
  useIsGuardrailsModeUpdating,
  useUpdateAnnotatorModel,
  useUpdateEnforcedMarks,
  useUpdateGuardrailsMode,
  useUpdatePersonApproval,
  useUpdateUnsupportedClientAction,
} from "@/lib/guardrails-deployment.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { isPersonalSubscription } from "@/lib/llm-key-subscription";
import { useLlmModels } from "@/lib/llm-models.query";
import { useAvailableLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";

/**
 * Whether tool calls are checked against the policy, and whether a call the
 * policy blocks still runs (Observe) or waits for a remedy (Enforce).
 */
export function OpenAppaEnforcementSetting() {
  const deployment = useGuardrailsDeployment({ poll: true });
  const update = useUpdateGuardrailsMode();
  const { data: canManage } = useHasPermissions({
    organizationSettings: ["update"],
  });
  const { isFresh } = useOpenAppaSetupState();
  const enabled = Boolean(deployment.data?.enabled);
  const observing = deployment.data?.mode === "observe";
  return (
    <SettingsBlock
      id="enforcement"
      title="Guardrails mode"
      description={
        <>
          {observing ? (
            <span>
              Guardrails observe your policy. Every tool call is checked and
              recorded, and the platform applies remedies for the agent where it
              can. Calls that need an enforced mark still wait.
            </span>
          ) : enabled ? (
            <span>
              Guardrails are on. Every tool call is checked against your policy
              before it runs.
            </span>
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
            <span>
              Guardrails are off. Your policy isn't applied, so agents can call
              any tool.
            </span>
          )}
          <span> {NEW_SESSIONS_NOTE}</span>
          {observing ? <ModesDocsLink /> : null}
        </>
      }
      control={
        deployment.data ? (
          <OptionSelect
            label="Guardrails mode"
            options={MODE_OPTIONS}
            value={deployment.data.mode}
            disabled={
              !canManage ||
              !deployment.data.featureEnabled ||
              isFresh !== false ||
              update.isPending
            }
            onChange={update.mutate}
          />
        ) : (
          <Skeleton className="h-9 w-48" />
        )
      }
    />
  );
}

/** Who answers what a person would be asked; only Enforce asks. */
export function OpenAppaPersonApprovalSetting() {
  const deployment = useGuardrailsDeployment({ poll: true });
  const update = useUpdatePersonApproval();
  const { data: canManage } = useHasPermissions({
    organizationSettings: ["update"],
  });
  const pinnedBy = deployment.data?.environmentOverrides.find(
    ({ setting }) => setting === "personApproval",
  )?.variable;
  const enforcing = deployment.data?.mode === "enforce";
  const modeUpdating = useIsGuardrailsModeUpdating();
  return (
    <SettingsBlock
      id="person-approval"
      title="Approvals"
      description={
        <>
          <span>
            Who answers when your policy asks a person to approve a call.{" "}
            {NEW_SESSIONS_NOTE}
          </span>
          {pinnedBy ? (
            <span>
              {" "}
              Set by <code className="font-mono text-xs">{pinnedBy}</code>.
            </span>
          ) : enforcing ? null : (
            <span> Applies in Enforce.</span>
          )}
        </>
      }
      control={
        deployment.data ? (
          <OptionSelect
            label="Approvals"
            options={APPROVAL_OPTIONS}
            value={deployment.data.personApproval}
            disabled={
              !canManage ||
              !deployment.data.featureEnabled ||
              !enforcing ||
              pinnedBy !== undefined ||
              modeUpdating ||
              update.isPending
            }
            onChange={update.mutate}
          />
        ) : (
          <Skeleton className="h-9 w-48" />
        )
      }
    />
  );
}

/** Marks that Observe and automatic approval never answer for. */
export function OpenAppaEnforcedMarksSetting() {
  const deployment = useGuardrailsDeployment({ poll: true });
  const update = useUpdateEnforcedMarks();
  const { data: canManage } = useHasPermissions({
    organizationSettings: ["update"],
  });
  const [draft, setDraft] = useState("");
  const marks = deployment.data?.enforcedMarks ?? [];
  const mark = draft.trim();
  const problem = markProblem(mark, marks);
  const disabled =
    !canManage || !deployment.data?.featureEnabled || update.isPending;
  const add = () => {
    if (problem === null)
      update.mutate({ add: mark }, { onSuccess: () => setDraft("") });
  };
  return (
    <SettingsBlock
      id="enforced-marks"
      title="Enforced marks"
      description="Observe and automatic approval never satisfy these marks; a person or your policy's own authority must."
      control={
        deployment.data ? (
          <div className="flex w-full flex-col gap-2 sm:w-80">
            <div className="flex gap-2">
              <Input
                aria-label="New enforced mark"
                placeholder="Mark"
                value={draft}
                disabled={disabled}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key !== "Enter" ||
                    event.nativeEvent.isComposing ||
                    event.keyCode === 229
                  )
                    return;
                  event.preventDefault();
                  add();
                }}
              />
              <Button
                variant="outline"
                disabled={disabled || problem !== null}
                onClick={add}
              >
                Add
              </Button>
            </div>
            {problem && mark ? (
              <p className="text-destructive text-xs">{problem}</p>
            ) : null}
            <div className="flex flex-wrap gap-1">
              {marks.map((saved) => (
                <Badge key={saved} variant="secondary">
                  <span className="font-mono">{saved}</span>
                  <UnstyledButton
                    aria-label={`Remove ${saved}`}
                    disabled={disabled}
                    className="ml-1 rounded-full"
                    onClick={() => update.mutate({ remove: saved })}
                  >
                    <X className="size-3" />
                  </UnstyledButton>
                </Badge>
              ))}
            </div>
          </div>
        ) : (
          <Skeleton className="h-9 w-80" />
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

type Option = { label: string; description: string };

const NEW_SESSIONS_NOTE =
  "Changes apply to new sessions; open sessions keep the setting they started with.";

const MODE_OPTIONS: Record<GuardrailsMode, Option> = {
  off: { label: "Off", description: "Your policy isn't applied." },
  observe: {
    label: "Observe",
    description:
      "Calls are checked and recorded; the platform remedies them where it can.",
  },
  enforce: {
    label: "Enforce",
    description: "Calls run only once your policy allows them.",
  },
};

const APPROVAL_OPTIONS: Record<PersonApproval, Option> = {
  ask: {
    label: "Ask the person",
    description: "The person running the session answers.",
  },
  auto_unattended: {
    label: "Automatic in Agent Runtime",
    description:
      "The platform answers in sessions opened with an Agent Runtime credential; people answer elsewhere.",
  },
  auto_everywhere: {
    label: "Always automatic",
    description: "The platform answers where it can, in every session.",
  },
};

/** Mirrors the backend's EnforcedMarksSchema. */
const MAX_MARKS = 64;
const MAX_MARK_LENGTH = 128;

function markProblem(mark: string, marks: string[]): string | null {
  if (!mark) return "Enter a mark.";
  if (mark.length > MAX_MARK_LENGTH)
    return `Use at most ${MAX_MARK_LENGTH} characters.`;
  if (mark.includes("\u0000")) return "A mark can't contain NUL.";
  if (marks.includes(mark)) return "Already added.";
  if (marks.length >= MAX_MARKS) return `Up to ${MAX_MARKS} marks.`;
  return null;
}

function isOption<T extends string>(
  options: Record<T, Option>,
  value: string,
): value is T {
  return Object.hasOwn(options, value);
}

function OptionSelect<T extends string>({
  label,
  options,
  value,
  disabled,
  onChange,
}: {
  label: string;
  options: Record<T, Option>;
  value: T;
  disabled: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(picked) => {
        if (isOption(options, picked)) onChange(picked);
      }}
    >
      <SelectTrigger aria-label={label} className="w-full lg:w-48">
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="end">
        {Object.entries<Option>(options).map(
          ([option, { label: name, description }]) => (
            <SelectItem key={option} value={option} description={description}>
              {name}
            </SelectItem>
          ),
        )}
      </SelectContent>
    </Select>
  );
}

/**
 * A docs link inside a sentence. A white-labeled deployment hides public docs
 * links; the words then stay as plain text so the sentence still reads whole.
 */
function ModesDocsLink() {
  const href = getVisibleDocsUrl(
    getDocsUrl(DocsPage.PlatformAiToolGuardrails, "off-observe-and-enforce"),
  );
  if (!href) return null;
  return (
    <>
      {" "}
      <ExternalDocsLink
        href={href}
        showIcon={false}
        className="text-primary underline underline-offset-2 hover:text-primary/80"
      >
        How Observe differs from Enforce
      </ExternalDocsLink>
    </>
  );
}

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
