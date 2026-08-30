"use client";

import { useId } from "react";
import { ContainerDeploymentFields } from "@/components/container-deployment-fields";
import { DeploymentEnvironmentVariablesEditor } from "@/components/deployment-environment-variables-editor";
import type { EnvVarDraft } from "@/components/environment-variable-dialog";
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
import { useExecutionCredentials } from "@/lib/execution-credentials.query";
import { useAppName } from "@/lib/hooks/use-app-name";

export type BackgroundExecutionConfig = {
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

export function defaultBackgroundExecution(
  defaultImage = "",
): BackgroundExecutionConfig {
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

export function AgentBackgroundExecutionFields({
  value,
  onChange,
}: {
  value: BackgroundExecutionConfig | null;
  onChange: (value: BackgroundExecutionConfig | null) => void;
}) {
  const enabledId = useId();
  const appName = useAppName();
  const runtimeEnabled = useFeature("agentBackgroundExecution");
  const executionCredentials = useExecutionCredentials(runtimeEnabled === true);
  const configuredDefaultImage = useFeature(
    "agentBackgroundExecutionBaseImage",
  );
  const defaultImage =
    typeof configuredDefaultImage === "string" ? configuredDefaultImage : "";
  const config = value ?? defaultBackgroundExecution(defaultImage);
  const update = (patch: Partial<BackgroundExecutionConfig>) =>
    onChange({ ...config, ...patch });
  const command = config.command?.[0] ?? "";
  const argumentsValue = (config.command ?? []).slice(1).join("\n");

  return (
    <div className="space-y-4" data-testid="agent-background-execution">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor={enabledId}>Background execution</Label>
          <p className="text-sm text-muted-foreground">
            Run durable tasks in an isolated deployment. Selecting this Agent in
            Chat opens an interactive execution instead of a foreground
            conversation.
          </p>
        </div>
        <Switch
          id={enabledId}
          checked={value !== null}
          disabled={runtimeEnabled !== true && value === null}
          onCheckedChange={(checked) =>
            onChange(checked ? defaultBackgroundExecution(defaultImage) : null)
          }
        />
      </div>

      {runtimeEnabled === false && value === null && (
        <p className="text-xs text-muted-foreground">
          Your deployment administrator must enable Agent background execution
          before you can configure it.
        </p>
      )}

      {value && (
        <div className="space-y-6 rounded-md border p-4">
          <div className="space-y-4">
            <div className="space-y-1">
              <h3 className="font-semibold text-base">Deployment</h3>
              <p className="text-xs text-muted-foreground">
                The container uses this Agent&apos;s Environment, including its
                network egress policy and image pull configuration.
              </p>
            </div>
            <ContainerDeploymentFields
              ids={{
                image: "background-execution-image",
                command: "background-execution-command",
                arguments: "background-execution-arguments",
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
            targetLabel="background deployment"
            installationLabel="Per user"
            staticLabel="Shared"
            installationCalloutTitle="Each user provides their own value"
            requiredDescription="Required credentials are checked before every run. Chat prompts the user to connect a missing value; other callers receive an error and can retry after it is connected."
            promptedValueLabel="per-user"
            deferStaticSecretValue
            installationOnlyForSecrets
            allowRequiredStaticSecret
            normalizeKey={uppercase}
            credentialBindingOptions={(executionCredentials.data ?? []).map(
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
                <Label htmlFor="background-execution-inference-protocol">
                  Inference API
                </Label>
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
                    id="background-execution-inference-protocol"
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
                <p className="text-xs text-muted-foreground">
                  Choose the API protocol the container&apos;s Agent client
                  expects. Every option stays behind the {appName} LLM proxy.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="background-execution-steering">Steering</Label>
                <Select
                  value={config.steerMode}
                  onValueChange={(steerMode: "pipe" | "tmux_keys") =>
                    update({ steerMode })
                  }
                >
                  <SelectTrigger
                    id="background-execution-steering"
                    className="w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pipe">Turn boundary</SelectItem>
                    <SelectItem value="tmux_keys">Terminal input</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Turn boundary delivers follow-up instructions between Agent
                  turns. Terminal input types directly into an interactive CLI.
                </p>
              </div>
              <NumberField
                id="background-execution-idle-timeout"
                label="Idle timeout (minutes)"
                value={config.idleTimeoutMinutes}
                min={1}
                max={1440}
                onChange={(idleTimeoutMinutes) =>
                  update({ idleTimeoutMinutes })
                }
                description="Stops the deployment after it finishes a task and receives no follow-up instructions for this long."
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <NumberField
                id="background-execution-max-duration"
                label="Maximum duration (hours)"
                value={config.ttlHours}
                min={1}
                max={720}
                onChange={(ttlHours) => update({ ttlHours })}
                description="Hard lifetime cap for a run, including active and idle time."
              />
              <NumberField
                id="background-execution-cost-budget"
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
                id="background-execution-cpu-request"
                label="CPU request"
                placeholder="500m"
                value={config.resources?.cpuRequest}
                onChange={(cpuRequest) =>
                  updateResource(config, update, { cpuRequest })
                }
              />
              <ResourceField
                id="background-execution-memory-request"
                label="Memory request"
                placeholder="1Gi"
                value={config.resources?.memoryRequest}
                onChange={(memoryRequest) =>
                  updateResource(config, update, { memoryRequest })
                }
              />
              <ResourceField
                id="background-execution-cpu-limit"
                label="CPU limit"
                placeholder="No limit"
                value={config.resources?.cpuLimit}
                onChange={(cpuLimit) =>
                  updateResource(config, update, { cpuLimit })
                }
              />
              <ResourceField
                id="background-execution-memory-limit"
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
              <Label htmlFor="background-execution-privileged">
                Privileged mode
              </Label>
              <p className="text-xs text-muted-foreground">
                Gives the container elevated access to its host. Enable it only
                for workloads that require host-level capabilities. Only Agent
                administrators can turn it on.
              </p>
            </div>
            <Switch
              id="background-execution-privileged"
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

function toEnvironmentDrafts(config: BackgroundExecutionConfig): EnvVarDraft[] {
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
  current: BackgroundExecutionConfig,
  drafts: EnvVarDraft[],
): Pick<BackgroundExecutionConfig, "environment" | "credentials"> {
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
      <p className="text-xs text-muted-foreground">{description}</p>
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
  config: BackgroundExecutionConfig,
  update: (patch: Partial<BackgroundExecutionConfig>) => void,
  patch: NonNullable<BackgroundExecutionConfig["resources"]>,
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
