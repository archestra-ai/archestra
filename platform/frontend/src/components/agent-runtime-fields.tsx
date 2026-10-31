"use client";

import {
  buildCustomAgentRuntime,
  getAgentRuntimeAllowedProtocols,
  resolveAgentRuntimeTiers,
  TOOL_TRANSFER_CREDENTIAL_SHORT_NAME,
} from "@archestra/shared";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { ContainerDeploymentFields } from "@/components/container-deployment-fields";
import { DeploymentEnvironmentVariablesEditor } from "@/components/deployment-environment-variables-editor";
import type {
  CredentialBindingOption,
  EnvVarDraft,
} from "@/components/environment-variable-dialog";
import { RuntimeCredentialDefinitionDialog } from "@/components/settings/runtime-credential-definition-dialog";
import { useCredentialsPageHref } from "@/components/settings-link";
import {
  SettingsSection,
  SettingsSectionGroup,
} from "@/components/settings-section";
import { FieldDescription } from "@/components/ui/field-description";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useOrganization } from "@/lib/organization.query";
import {
  type RuntimeCredentialDefinition,
  useCanAttachCredential,
  useRuntimeCredentials,
} from "@/lib/runtime-credentials.query";

export type AgentRuntimeTier = "S" | "M" | "L";

export type AgentRuntimeConfig = {
  image: string;
  command: string[] | null;
  inferenceProtocol: "openai_responses" | "openai_chat" | "anthropic";
  backend: "kubernetes";
  steerMode: "pipe" | "tmux_keys";
  privileged: boolean;
  /** The default tier of a run's container; absent means M. */
  tier?: AgentRuntimeTier;
  /** The scaleup tier, the largest a run may ask for; absent means `tier`. */
  maxTier?: AgentRuntimeTier;
  ports?: number[];
  environment: Array<{ key: string; value: string }> | null;
  credentials: Array<{
    key: string;
    credentialId?: string;
    scope: "shared" | "per_user";
    label: string;
    description?: string;
    required: boolean;
  }> | null;
  /** Undefined means enabled. Only an explicit `false` refuses a transfer. */
  allowAgentSuppliedCredentialValues?: boolean;
  claudeCode?: {
    authentication: "provider" | "subscription";
    model?: string;
  };
  ttlHours: number | null;
  maxCostUsd: number | null;
  idleTimeoutMinutes: number | null;
};

export function defaultAgentRuntime(): AgentRuntimeConfig {
  return buildCustomAgentRuntime({ image: "" });
}

export function AgentRuntimeFields({
  value,
  onChange,
}: {
  value: AgentRuntimeConfig | null;
  onChange: (value: AgentRuntimeConfig | null) => void;
}) {
  const enabledId = useId();
  const credentialsHref = useCredentialsPageHref();
  const runtimeEnabled = useFeature("agentRuntime");
  const config = value ?? defaultAgentRuntime();

  return (
    <div data-testid="agent-runtime">
      <SettingsSectionGroup>
        <SettingsSection
          title="Dedicated runtime"
          description="Run this agent in its own container."
        >
          <div className="flex items-start gap-3">
            <Switch
              id={enabledId}
              aria-label="Dedicated Agent runtime"
              className="mt-0.5 shrink-0"
              checked={value !== null}
              disabled={runtimeEnabled !== true && value === null}
              onCheckedChange={(checked) =>
                onChange(checked ? defaultAgentRuntime() : null)
              }
            />
            <div className="min-w-0 space-y-1">
              <Label htmlFor={enabledId}>
                {value ? "Enabled" : "Disabled"}
              </Label>
              <FieldDescription>
                {runtimeEnabled === false
                  ? value === null
                    ? "Unavailable: this cluster does not have the Agent Sandbox controller installed."
                    : "Agent Runtime is off on this deployment, so runs fail. Turn this off to answer in regular conversations instead."
                  : "Selecting this agent in Chat starts a run in the container instead of a foreground conversation."}
              </FieldDescription>
            </div>
          </div>
        </SettingsSection>
        {value && (
          <>
            <SettingsSection
              title="Container"
              description="The image and client each run starts. It inherits this agent's network egress policy and image pull settings."
            >
              <AgentRuntimeImageFields value={config} onChange={onChange} />
              <div className="grid gap-4 sm:grid-cols-2">
                <AgentRuntimeProtocolField
                  value={config}
                  onChange={onChange}
                  constrainToHarness
                  compact
                />
                <AgentRuntimeSteeringField
                  value={config}
                  onChange={onChange}
                  compact
                />
              </div>
            </SettingsSection>
            <SettingsSection
              title="Environment"
              description={
                <>
                  Configuration and secrets passed to the container. Manage
                  reusable credentials on the{" "}
                  <Link
                    href={credentialsHref}
                    className="underline underline-offset-4"
                  >
                    Credentials
                  </Link>{" "}
                  page.
                </>
              }
            >
              <AgentRuntimeEnvironmentFields
                value={config}
                onChange={onChange}
                hideLabel
                hideDescription
              />
            </SettingsSection>
            <SettingsSection
              title="Limits"
              description="Run lifetime, spend and container size. Blank fields use installation defaults."
            >
              <AgentRuntimeRunLimits value={config} onChange={onChange} />
              <AgentRuntimeTierFields value={config} onChange={onChange} />
            </SettingsSection>
            <SettingsSection
              title="Access"
              description="The ports people can open on a run, and whether its container may reach its host."
            >
              <AgentRuntimeAccessFields value={config} onChange={onChange} />
            </SettingsSection>
          </>
        )}
      </SettingsSectionGroup>
    </div>
  );
}

type RuntimeSectionProps = {
  value: AgentRuntimeConfig;
  onChange: (value: AgentRuntimeConfig) => void;
};

export const AGENT_RUNTIME_PROTOCOL_LABELS = {
  openai_responses: "OpenAI Responses",
  openai_chat: "OpenAI Chat Completions",
  anthropic: "Anthropic Messages",
};

export function AgentRuntimeImageFields({
  value,
  onChange,
}: RuntimeSectionProps) {
  const config = value;
  const update = (patch: Partial<AgentRuntimeConfig>) =>
    onChange({ ...config, ...patch });
  const command = config.command?.[0] ?? "";
  const argumentsValue = (config.command ?? []).slice(1).join("\n");
  return (
    <ContainerDeploymentFields
      ids={{
        image: "agent-runtime-image",
        command: "agent-runtime-command",
        arguments: "agent-runtime-arguments",
      }}
      value={{
        image: config.image,
        command,
        arguments: argumentsValue,
      }}
      onChange={(next) =>
        update({
          image: next.image,
          command: toCommand(next.command, next.arguments),
        })
      }
      image={{ placeholder: "registry.example.com/my-agent:latest" }}
      command={{
        placeholder: "my-agent",
        description: "The executable that starts your Agent client.",
      }}
      arguments={{
        placeholder: "--permission-mode\nbypassPermissions",
      }}
    />
  );
}

export function AgentRuntimeEnvironmentFields({
  value,
  onChange,
  hideLabel = false,
  hideDescription = false,
}: RuntimeSectionProps & { hideLabel?: boolean; hideDescription?: boolean }) {
  const appName = useAppName();
  const credentialsHref = useCredentialsPageHref();
  const config = value;
  const update = (patch: Partial<AgentRuntimeConfig>) =>
    onChange({ ...config, ...patch });
  const runtimeEnabled = useFeature("agentRuntime");
  const runtimeCredentials = useRuntimeCredentials(runtimeEnabled === true);
  const canAttach = useCanAttachCredential();
  const { data: canCreateCredential } = useHasPermissions({
    credential: ["create"],
  });
  // A credential being created from the variable dialog's source picker: the
  // prefill it opens with, and how to hand the result back to that dialog.
  const [creating, setCreating] = useState<{
    key: string;
    description: string;
    resolve: (option: CredentialBindingOption | null) => void;
  } | null>(null);
  return (
    <div className="space-y-4">
      {creating && (
        <RuntimeCredentialDefinitionDialog
          definition={null}
          initialKind="secret"
          initialValues={{
            name: creating.key,
            description: creating.description,
            icon: null,
          }}
          backLabel="Back to the variable"
          onClose={() => {
            creating.resolve(null);
            setCreating(null);
          }}
          onCreated={async (id) => {
            const { data } = await runtimeCredentials.refetch();
            const created = data?.find((definition) => definition.id === id);
            creating.resolve(
              created ? toCredentialBindingOption(created) : null,
            );
            setCreating(null);
          }}
        />
      )}
      <DeploymentEnvironmentVariablesEditor
        onCreateCredential={
          canCreateCredential
            ? (prefill) =>
                new Promise((resolve) => setCreating({ ...prefill, resolve }))
            : undefined
        }
        hideHeading={hideLabel}
        value={toEnvironmentDrafts(config)}
        onChange={(drafts) => update(fromEnvironmentDrafts(config, drafts))}
        description={
          hideDescription ? null : (
            <>
              What the agent logs in with inside its container, and the settings
              it reads. Without a token it can use your tools through {appName}{" "}
              but can&apos;t push to a repo. Reusable credentials live on the{" "}
              <Link
                href={credentialsHref}
                className="font-medium text-foreground underline underline-offset-4"
              >
                Credentials
              </Link>{" "}
              page.
            </>
          )
        }
        targetLabel="dedicated runtime"
        installationLabel="Per user"
        staticLabel="Shared"
        installationDescription="Each user provides their own value."
        staticDescription="The same value is used for every run."
        requiredDescription="Required credentials are checked before every run. Chat prompts the user to connect a missing value; other callers receive an error and can retry after it is connected."
        promptedValueLabel="per-user"
        deferStaticSecretValue
        installationOnlyForSecrets
        allowRequiredStaticSecret
        normalizeKey={uppercase}
        credentialBindingOptions={(runtimeCredentials.data ?? []).map(
          (definition) => ({
            ...toCredentialBindingOption(definition),
            canAttach: canAttach(definition.id),
          }),
        )}
      />

      <RuntimeClientCredentialsField value={config} onChange={onChange} />
    </div>
  );
}

function toCredentialBindingOption(
  definition: RuntimeCredentialDefinition,
): CredentialBindingOption {
  return {
    id: definition.key,
    label: definition.name,
    icon:
      definition.icon ??
      (definition.kind === "github_app_user" || definition.kind === "github_app"
        ? "logo:github"
        : null),
    sourceLabel:
      definition.kind === "github_app_user"
        ? "GitHub connection"
        : definition.kind === "github_app"
          ? "GitHub App connection"
          : undefined,
    defaultKey: defaultCredentialEnvironmentKey(definition.key),
    description: definition.description,
    allowedScopes: [
      ...(definition.allowPersonal ? (["installation"] as const) : []),
      ...(definition.allowOrganization ? (["static"] as const) : []),
    ],
  };
}

function RuntimeClientCredentialsField({
  value,
  onChange,
}: RuntimeSectionProps) {
  const update = (patch: Partial<AgentRuntimeConfig>) =>
    onChange({ ...value, ...patch });
  return (
    <div className="flex items-start gap-3 border-t pt-4">
      <Switch
        id="agent-runtime-allow-client-credentials"
        className="mt-0.5 shrink-0"
        checked={value.allowAgentSuppliedCredentialValues !== false}
        onCheckedChange={(allowed) =>
          update({ allowAgentSuppliedCredentialValues: allowed })
        }
      />
      <div className="min-w-0 space-y-1">
        <Label htmlFor="agent-runtime-allow-client-credentials">
          Accept credentials from a connected client
        </Label>
        <FieldDescription>
          During a handoff your laptop agent can pass its own token with{" "}
          <code>{TOOL_TRANSFER_CREDENTIAL_SHORT_NAME}</code>. It serves only
          that person&apos;s runs, but the model sees the value and the client
          keeps it in its chat history.
        </FieldDescription>
      </div>
    </div>
  );
}

export function AgentRuntimeProtocolField({
  value,
  onChange,
  constrainToHarness = false,
  hideLabel = false,
  compact = false,
}: RuntimeSectionProps & {
  constrainToHarness?: boolean;
  hideLabel?: boolean;
  /** Label above, one short line below: for a field sharing a row. */
  compact?: boolean;
}) {
  const config = value;
  const update = (patch: Partial<AgentRuntimeConfig>) =>
    onChange({ ...config, ...patch });
  const appName = useAppName();
  const allowedProtocols = getAgentRuntimeAllowedProtocols(
    constrainToHarness ? value.command : null,
  );
  return (
    <div className="space-y-2">
      <Label
        htmlFor="agent-runtime-inference-protocol"
        className={hideLabel ? "sr-only" : undefined}
      >
        Inference API
      </Label>
      {!compact && (
        <FieldDescription>
          Choose the API protocol the container&apos;s Agent client expects.
          Every option stays behind the {appName} LLM proxy.
        </FieldDescription>
      )}
      {!compact && constrainToHarness && allowedProtocols.length === 1 && (
        <FieldDescription>
          Claude Code only speaks the Anthropic Messages API, so this cannot be
          changed.
        </FieldDescription>
      )}
      <Select
        disabled={allowedProtocols.length === 1}
        value={config.inferenceProtocol}
        onValueChange={(
          inferenceProtocol: "openai_responses" | "openai_chat" | "anthropic",
        ) => update({ inferenceProtocol })}
      >
        <SelectTrigger id="agent-runtime-inference-protocol" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {allowedProtocols.map((protocol) => (
            <SelectItem key={protocol} value={protocol}>
              {AGENT_RUNTIME_PROTOCOL_LABELS[protocol]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {compact && (
        <FieldDescription>
          {allowedProtocols.length === 1 && constrainToHarness
            ? "Fixed by the client in this image."
            : `What the client speaks to the ${appName} LLM proxy.`}
        </FieldDescription>
      )}
    </div>
  );
}

export function AgentRuntimeSteeringField({
  value,
  onChange,
  hideLabel = false,
  compact = false,
}: RuntimeSectionProps & { hideLabel?: boolean; compact?: boolean }) {
  const config = value;
  const update = (patch: Partial<AgentRuntimeConfig>) =>
    onChange({ ...config, ...patch });
  return (
    <div className="space-y-2">
      <Label
        htmlFor="agent-runtime-steering"
        className={hideLabel ? "sr-only" : undefined}
      >
        Steering
      </Label>
      {!compact && (
        <FieldDescription>
          Turn boundary delivers follow-up instructions between Agent turns.
          Terminal input types directly into an interactive CLI.
        </FieldDescription>
      )}
      <Select
        value={config.steerMode}
        onValueChange={(steerMode: "pipe" | "tmux_keys") =>
          update({ steerMode })
        }
      >
        <SelectTrigger id="agent-runtime-steering" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="pipe">Turn boundary</SelectItem>
          <SelectItem value="tmux_keys">Terminal input</SelectItem>
        </SelectContent>
      </Select>
      {compact && (
        <FieldDescription>
          {config.steerMode === "tmux_keys"
            ? "Follow-ups are typed into the client's terminal."
            : "Follow-ups are delivered between turns."}
        </FieldDescription>
      )}
    </div>
  );
}

/** Limits, tiers and access, for surfaces with no section of their own. */
export function AgentRuntimeRunControls({
  value,
  onChange,
}: RuntimeSectionProps) {
  return (
    <div className="space-y-5">
      <AgentRuntimeRunLimits value={value} onChange={onChange} />
      <AgentRuntimeTierFields value={value} onChange={onChange} />
      <AgentRuntimeAccessFields value={value} onChange={onChange} />
    </div>
  );
}

function AgentRuntimeRunLimits({ value, onChange }: RuntimeSectionProps) {
  const update = (patch: Partial<AgentRuntimeConfig>) =>
    onChange({ ...value, ...patch });
  const runtimeDefaults = useFeature("agentRuntimeBackend");
  return (
    <div className="grid gap-x-4 gap-y-5 sm:grid-cols-3">
      <NumberField
        id="runtime-idle-timeout"
        label="Idle timeout"
        unit="min"
        value={value.idleTimeoutMinutes}
        defaultValue={runtimeDefaults?.defaultIdleTimeoutMinutes}
        min={1}
        max={1440}
        onChange={(idleTimeoutMinutes) => update({ idleTimeoutMinutes })}
        description="Stops the run after it finishes a task and gets no follow-up for this long."
      />
      <NumberField
        id="agent-runtime-max-duration"
        label="Maximum duration"
        unit="hours"
        value={value.ttlHours}
        defaultValue={runtimeDefaults?.defaultTtlHours}
        min={1}
        max={720}
        onChange={(ttlHours) => update({ ttlHours })}
        description="Hard lifetime cap, including idle time."
      />
      <NumberField
        id="agent-runtime-cost-budget"
        label="Metered LLM budget"
        unit="USD"
        value={value.maxCostUsd}
        defaultValue="No limit"
        min={1}
        max={100000}
        onChange={(maxCostUsd) => update({ maxCostUsd })}
        description="Blocks further metered model calls once a run spends this much."
      />
    </div>
  );
}

/** The tier a run's container gets, and the largest tier a run may ask for. */
function AgentRuntimeTierFields({ value, onChange }: RuntimeSectionProps) {
  const update = (patch: Partial<AgentRuntimeConfig>) =>
    onChange({ ...value, ...patch });
  const runtimeDefaults = useFeature("agentRuntimeBackend");
  // Sizes come from the organization's tier settings over the code defaults.
  const { data: organization } = useOrganization();
  const tiers = resolveAgentRuntimeTiers(organization?.agentRuntimeTiers);
  const defaultTier = value.tier ?? runtimeDefaults?.defaultTier ?? "M";
  // Never below the default tier: a smaller value counts as the default tier.
  const scaleupTier =
    value.maxTier &&
    TIER_ORDER.indexOf(value.maxTier) > TIER_ORDER.indexOf(defaultTier)
      ? value.maxTier
      : defaultTier;
  return (
    <div className="grid gap-x-4 gap-y-5 sm:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor="agent-runtime-tier">Default tier</Label>
        <Select
          value={defaultTier}
          onValueChange={(tier: AgentRuntimeTier) =>
            // A default tier above the saved scaleup tier raises it too, so
            // the saved pair matches what the form shows.
            update(
              TIER_ORDER.indexOf(tier) > TIER_ORDER.indexOf(scaleupTier)
                ? { tier, maxTier: tier }
                : { tier },
            )
          }
        >
          <SelectTrigger id="agent-runtime-tier" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIER_ORDER.map((tier) => (
              <SelectItem key={tier} value={tier}>
                {tierLabel(tier, tiers[tier])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>
          The CPU and memory of a run's container. A caller that starts a run
          can ask for another tier, up to the scaleup tier.
        </FieldDescription>
      </div>
      <div className="space-y-2">
        <Label htmlFor="agent-runtime-max-tier">Scaleup tier</Label>
        <Select
          value={scaleupTier}
          onValueChange={(maxTier: AgentRuntimeTier) => update({ maxTier })}
        >
          <SelectTrigger id="agent-runtime-max-tier" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIER_ORDER.slice(TIER_ORDER.indexOf(defaultTier)).map((tier) => (
              <SelectItem key={tier} value={tier}>
                {tierLabel(tier, tiers[tier])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>
          The largest tier a run may ask for. A run whose work needs more CPU or
          memory starts a run of this agent at a larger tier and hands its work
          over.
        </FieldDescription>
      </div>
    </div>
  );
}

/** The ports people can open on a run, and host access. */
function AgentRuntimeAccessFields({ value, onChange }: RuntimeSectionProps) {
  const update = (patch: Partial<AgentRuntimeConfig>) =>
    onChange({ ...value, ...patch });
  return (
    <div className="space-y-5">
      <RuntimePortsField
        value={value.ports ?? []}
        onChange={(ports) => update({ ports })}
      />
      <div className="flex items-start gap-3">
        <Switch
          id="agent-runtime-privileged"
          className="mt-0.5 shrink-0"
          checked={value.privileged}
          onCheckedChange={(privileged) => update({ privileged })}
        />
        <div className="min-w-0 space-y-1">
          <Label htmlFor="agent-runtime-privileged">Privileged mode</Label>
          <FieldDescription>
            Gives the container elevated access to its host. Only Agent
            administrators can turn it on.
          </FieldDescription>
        </div>
      </div>
    </div>
  );
}

function RuntimePortsField({
  value,
  onChange,
}: {
  value: number[];
  onChange: (ports: number[]) => void;
}) {
  const [draft, setDraft] = useState(value.join(", "));
  const lastEmitted = useRef<string | null>(null);
  useEffect(() => {
    const incoming = value.join(", ");
    if (incoming !== lastEmitted.current) setDraft(incoming);
  }, [value]);
  const parts = draft.trim() ? draft.split(/[\s,]+/).filter(Boolean) : [];
  const ports = parts.map(Number);
  const valid =
    ports.length <= 20 &&
    ports.every(
      (port) => Number.isInteger(port) && port >= 1 && port <= 65_535,
    );

  return (
    <div className="space-y-2">
      <Label htmlFor="agent-runtime-ports">Ports to forward</Label>
      <Input
        id="agent-runtime-ports"
        inputMode="numeric"
        placeholder="3000, 9000"
        value={draft}
        aria-invalid={!valid}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          const parsed = next.trim()
            ? next
                .split(/[\s,]+/)
                .filter(Boolean)
                .map(Number)
            : [];
          if (
            parsed.length <= 20 &&
            parsed.every(
              (port) => Number.isInteger(port) && port >= 1 && port <= 65_535,
            )
          ) {
            const unique = [...new Set(parsed)];
            lastEmitted.current = unique.join(", ");
            onChange(unique);
          }
        }}
      />
      <FieldDescription>
        {valid
          ? "Comma-separated, up to 20. Shown in the run's connection details."
          : "Use up to 20 port numbers from 1 to 65535."}
      </FieldDescription>
    </div>
  );
}

function toCommand(commandValue: string, argumentsValue: string) {
  const command = commandValue.trim();
  if (!command) return null;
  const args = argumentsValue
    .split("\n")
    .map((argument) => argument.trim())
    .filter(Boolean);
  return [command, ...args];
}

function toEnvironmentDrafts(config: AgentRuntimeConfig): EnvVarDraft[] {
  return [
    ...(config.environment ?? []).map(
      ({ key, value }): EnvVarDraft => ({
        key,
        type: "plain_text",
        scope: "static",
        required: false,
        description: "",
        value,
      }),
    ),
    ...(config.credentials ?? []).map(
      (credential): EnvVarDraft => ({
        key: credential.key,
        type: "secret",
        scope: credential.scope === "per_user" ? "installation" : "static",
        required: credential.required,
        description: credential.description ?? "",
        value: "",
        credentialId: credential.credentialId,
      }),
    ),
  ];
}

function fromEnvironmentDrafts(
  current: AgentRuntimeConfig,
  drafts: EnvVarDraft[],
): Pick<AgentRuntimeConfig, "environment" | "credentials"> {
  const environment = drafts
    .filter((draft) => draft.type !== "secret")
    .map((draft) => ({ key: draft.key, value: draft.value }));
  const credentials = drafts
    .filter((draft) => draft.type === "secret")
    .map((draft) => ({
      key: draft.key,
      credentialId: draft.credentialId,
      scope:
        draft.scope === "installation"
          ? ("per_user" as const)
          : ("shared" as const),
      label:
        current.credentials?.find((credential) => credential.key === draft.key)
          ?.label ?? humanizeEnvironmentKey(draft.key),
      description: draft.description || undefined,
      required: draft.required,
    }));
  return {
    environment: environment.length > 0 ? environment : null,
    credentials: credentials.length > 0 ? credentials : null,
  };
}

function defaultCredentialEnvironmentKey(key: string): string {
  if (key === "github") return "GITHUB_TOKEN";
  return uppercase(key.replace(/[.-]+/g, "_"));
}

function humanizeEnvironmentKey(key: string): string {
  return key
    .split("_")
    .filter(Boolean)
    .map(
      (part) =>
        ENVIRONMENT_KEY_LABELS[part] ??
        `${part[0]?.toUpperCase()}${part.slice(1).toLowerCase()}`,
    )
    .join(" ");
}

function uppercase(value: string): string {
  return value.toUpperCase();
}

function NumberField({
  id,
  label,
  unit,
  value,
  min,
  max,
  onChange,
  description,
  defaultValue,
}: {
  id: string;
  label: string;
  unit: string;
  value: number | null;
  min: number;
  max: number;
  onChange: (value: number | null) => void;
  description: string;
  defaultValue: string | number | undefined;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <InputGroup>
        <InputGroupInput
          id={id}
          type="number"
          min={min}
          max={max}
          value={value ?? ""}
          onChange={(event) => {
            const next = event.currentTarget.valueAsNumber;
            onChange(
              Number.isFinite(next) ? Math.min(max, Math.max(min, next)) : null,
            );
          }}
          placeholder={installationDefaultPlaceholder(defaultValue)}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupText>{unit}</InputGroupText>
        </InputGroupAddon>
      </InputGroup>
      <FieldDescription>{description}</FieldDescription>
    </div>
  );
}

const TIER_ORDER: AgentRuntimeTier[] = ["S", "M", "L"];

function tierLabel(
  tier: AgentRuntimeTier,
  resources?: {
    cpuRequest: string;
    memoryRequest: string;
    memoryLimit: string;
  },
): string {
  if (!resources) return tier;
  return `${tier}: ${resources.cpuRequest} CPU, ${resources.memoryRequest} memory (${resources.memoryLimit} limit)`;
}

const ENVIRONMENT_KEY_LABELS: Record<string, string> = {
  API: "API",
  AWS: "AWS",
  GCP: "GCP",
  GITHUB: "GitHub",
  ID: "ID",
  SSH: "SSH",
  URL: "URL",
};

function installationDefaultPlaceholder(
  value: string | number | undefined,
): string {
  return value === undefined ? "Loading default…" : `${value} (default)`;
}
