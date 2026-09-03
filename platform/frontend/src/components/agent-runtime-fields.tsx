"use client";

import { useId } from "react";
import { ContainerDeploymentFields } from "@/components/container-deployment-fields";
import { DeploymentEnvironmentVariablesEditor } from "@/components/deployment-environment-variables-editor";
import type { EnvVarDraft } from "@/components/environment-variable-dialog";
import { FieldDescription } from "@/components/ui/field-description";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useFeature } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useRuntimeCredentials } from "@/lib/runtime-credentials.query";

export type AgentRuntimeConfig = {
  image: string;
  command: string[] | null;
  inferenceProtocol: "openai_responses" | "openai_chat" | "anthropic";
  backend: "kubernetes";
  steerMode: "pipe" | "tmux_keys";
  privileged: boolean;
  resources: {
    cpuRequest?: string;
    memoryRequest?: string;
    cpuLimit?: string;
    memoryLimit?: string;
  } | null;
  environment: Array<{ key: string; value: string }> | null;
  credentials: Array<{
    key: string;
    credentialId?: string;
    scope: "shared" | "per_user";
    label: string;
    description?: string;
    required: boolean;
  }> | null;
  ttlHours: number | null;
  maxCostUsd: number | null;
  idleTimeoutMinutes: number | null;
};

export function defaultAgentRuntime(defaultImage = ""): AgentRuntimeConfig {
  return {
    image: defaultImage,
    command: null,
    inferenceProtocol: "openai_responses",
    backend: "kubernetes",
    steerMode: "pipe",
    privileged: false,
    resources: null,
    environment: null,
    credentials: null,
    ttlHours: null,
    maxCostUsd: null,
    idleTimeoutMinutes: null,
  };
}

export function AgentRuntimeFields({
  value,
  onChange,
}: {
  value: AgentRuntimeConfig | null;
  onChange: (value: AgentRuntimeConfig | null) => void;
}) {
  const enabledId = useId();
  const appName = useAppName();
  const runtimeEnabled = useFeature("agentRuntime");
  const runtimeCredentials = useRuntimeCredentials(runtimeEnabled === true);
  const configuredDefaultImage = useFeature("agentRuntimeBaseImage");
  const defaultImage =
    typeof configuredDefaultImage === "string" ? configuredDefaultImage : "";
  const config = value ?? defaultAgentRuntime(defaultImage);
  const update = (patch: Partial<AgentRuntimeConfig>) =>
    onChange({ ...config, ...patch });
  const command = config.command?.[0] ?? "";
  const argumentsValue = (config.command ?? []).slice(1).join("\n");

  return (
    <div className="space-y-4" data-testid="agent-runtime">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor={enabledId}>Dedicated runtime</Label>
          <FieldDescription>
            Give this Agent an isolated environment for interactive, delegated,
            and long-running work. Selecting it in Chat starts a run instead of
            a foreground conversation.
          </FieldDescription>
          {runtimeEnabled === false && value === null && (
            <FieldDescription>
              Your deployment administrator must enable Agent Runtime before you
              can configure a dedicated runtime.
            </FieldDescription>
          )}
        </div>
        <Switch
          id={enabledId}
          checked={value !== null}
          disabled={runtimeEnabled !== true && value === null}
          onCheckedChange={(checked) =>
            onChange(checked ? defaultAgentRuntime(defaultImage) : null)
          }
        />
      </div>

      {value && (
        <div className="space-y-6 rounded-md border p-4">
          <div className="space-y-4">
            <div className="space-y-1">
              <h3 className="font-semibold text-base">Runtime image</h3>
              <p className="text-xs text-muted-foreground">
                The container uses this Agent&apos;s Environment, including its
                network egress policy and image pull configuration.
              </p>
            </div>
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
              image={{ placeholder: defaultImage }}
              command={{
                placeholder: "Use the image's default command",
                description: "Leave blank to use the image's default command.",
              }}
              arguments={{
                placeholder: "--permission-mode\nbypassPermissions",
              }}
            />
          </div>

          <DeploymentEnvironmentVariablesEditor
            value={toEnvironmentDrafts(config)}
            onChange={(drafts) => update(fromEnvironmentDrafts(config, drafts))}
            description="Add plain configuration and declare secrets in one place. Secret values are provided after the Agent is saved."
            targetLabel="dedicated runtime"
            installationLabel="Per user"
            staticLabel="Shared"
            installationCalloutTitle="Each user provides their own value"
            requiredDescription="Required credentials are checked before every run. Chat prompts the user to connect a missing value; other callers receive an error and can retry after it is connected."
            promptedValueLabel="per-user"
            deferStaticSecretValue
            installationOnlyForSecrets
            allowRequiredStaticSecret
            normalizeKey={uppercase}
            credentialBindingOptions={(runtimeCredentials.data ?? []).map(
              (definition) => ({
                id: definition.key,
                label: definition.name,
                icon: definition.icon,
                defaultKey: defaultCredentialEnvironmentKey(definition.key),
                description: definition.description,
                allowedScopes: [
                  ...(definition.allowPersonal
                    ? (["installation"] as const)
                    : []),
                  ...(definition.allowOrganization
                    ? (["static"] as const)
                    : []),
                ],
              }),
            )}
          />

          <div className="space-y-4">
            <div className="space-y-1">
              <h3 className="font-semibold text-base">Run controls</h3>
              <p className="text-xs text-muted-foreground">
                Bound each isolated run. Blank fields use the installation
                defaults.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="agent-runtime-inference-protocol">
                  Inference API
                </Label>
                <FieldDescription>
                  Choose the API protocol the container&apos;s Agent client
                  expects. Every option stays behind the {appName} LLM proxy.
                </FieldDescription>
                <Select
                  value={config.inferenceProtocol}
                  onValueChange={(
                    inferenceProtocol:
                      | "openai_responses"
                      | "openai_chat"
                      | "anthropic",
                  ) => update({ inferenceProtocol })}
                >
                  <SelectTrigger
                    id="agent-runtime-inference-protocol"
                    className="w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai_responses">
                      OpenAI Responses
                    </SelectItem>
                    <SelectItem value="openai_chat">
                      OpenAI Chat Completions
                    </SelectItem>
                    <SelectItem value="anthropic">
                      Anthropic Messages
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="agent-runtime-steering">Steering</Label>
                <FieldDescription>
                  Turn boundary delivers follow-up instructions between Agent
                  turns. Terminal input types directly into an interactive CLI.
                </FieldDescription>
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
              </div>
              <NumberField
                id="runtime-idle-timeout"
                label="Idle timeout (minutes)"
                value={config.idleTimeoutMinutes}
                min={1}
                max={1440}
                onChange={(idleTimeoutMinutes) =>
                  update({ idleTimeoutMinutes })
                }
                description="Stops the run after it finishes a task and receives no follow-up instructions for this long."
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <NumberField
                id="agent-runtime-max-duration"
                label="Maximum duration (hours)"
                value={config.ttlHours}
                min={1}
                max={720}
                onChange={(ttlHours) => update({ ttlHours })}
                description="Hard lifetime cap for a run, including active and idle time."
              />
              <NumberField
                id="agent-runtime-cost-budget"
                label="Metered LLM budget (USD)"
                value={config.maxCostUsd}
                min={1}
                max={100000}
                onChange={(maxCostUsd) => update({ maxCostUsd })}
                description="Blocks further metered model calls after this run reaches the spend ceiling."
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <ResourceField
                id="agent-runtime-cpu-request"
                label="CPU request"
                placeholder="500m"
                value={config.resources?.cpuRequest}
                onChange={(cpuRequest) =>
                  updateResource(config, update, { cpuRequest })
                }
              />
              <ResourceField
                id="agent-runtime-memory-request"
                label="Memory request"
                placeholder="1Gi"
                value={config.resources?.memoryRequest}
                onChange={(memoryRequest) =>
                  updateResource(config, update, { memoryRequest })
                }
              />
              <ResourceField
                id="agent-runtime-cpu-limit"
                label="CPU limit"
                placeholder="No limit"
                value={config.resources?.cpuLimit}
                onChange={(cpuLimit) =>
                  updateResource(config, update, { cpuLimit })
                }
              />
              <ResourceField
                id="agent-runtime-memory-limit"
                label="Memory limit"
                placeholder="4Gi"
                value={config.resources?.memoryLimit}
                onChange={(memoryLimit) =>
                  updateResource(config, update, { memoryLimit })
                }
              />
            </div>
          </div>

          <div className="flex w-full items-center justify-between gap-6 rounded-md border p-4">
            <div className="min-w-0 space-y-1">
              <Label htmlFor="agent-runtime-privileged">Privileged mode</Label>
              <FieldDescription>
                Gives the container elevated access to its host. Enable it only
                for workloads that require host-level capabilities. Only Agent
                administrators can turn it on.
              </FieldDescription>
            </div>
            <Switch
              id="agent-runtime-privileged"
              className="shrink-0"
              checked={config.privileged}
              onCheckedChange={(privileged) => update({ privileged })}
            />
          </div>
        </div>
      )}
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
  if (key === "claude-code") return "CLAUDE_CODE_OAUTH_TOKEN";
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
  value,
  min,
  max,
  onChange,
  description,
}: {
  id: string;
  label: string;
  value: number | null;
  min: number;
  max: number;
  onChange: (value: number | null) => void;
  description: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <FieldDescription>{description}</FieldDescription>
      <Input
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
        placeholder="Installation default"
      />
    </div>
  );
}

function ResourceField({
  id,
  label,
  placeholder,
  value,
  onChange,
}: {
  id: string;
  label: string;
  placeholder: string;
  value?: string;
  onChange: (value: string | undefined) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || undefined)}
        placeholder={placeholder}
        className="font-mono"
      />
    </div>
  );
}

function updateResource(
  config: AgentRuntimeConfig,
  update: (patch: Partial<AgentRuntimeConfig>) => void,
  patch: NonNullable<AgentRuntimeConfig["resources"]>,
) {
  const resources = { ...(config.resources ?? {}), ...patch };
  update({
    resources: Object.values(resources).some(Boolean) ? resources : null,
  });
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
