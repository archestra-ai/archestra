"use client";

import { Plus, Trash2 } from "lucide-react";
import { useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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

const BACKGROUND_EXECUTION_IMAGE_PLACEHOLDER =
  "ghcr.io/example/background-agent:1.0.0";

export type BackgroundExecutionConfig = {
  image: string;
  command: string[] | null;
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
    scope: "shared" | "per_user";
    label: string;
    description?: string;
    required: boolean;
  }> | null;
  ttlHours: number | null;
  idleTimeoutMinutes: number | null;
};

export function defaultBackgroundExecution(): BackgroundExecutionConfig {
  return {
    image: "",
    command: null,
    backend: "kubernetes",
    steerMode: "pipe",
    privileged: false,
    resources: null,
    environment: null,
    credentials: null,
    ttlHours: null,
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
  const runtimeEnabled = useFeature("agentBackgroundExecution");
  const config = value ?? defaultBackgroundExecution();
  const update = (patch: Partial<BackgroundExecutionConfig>) =>
    onChange({ ...config, ...patch });

  return (
    <div className="space-y-4" data-testid="agent-background-execution">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor={enabledId}>Background execution</Label>
          <p className="text-sm text-muted-foreground">
            Run delegated tasks in a dedicated deployment. Direct chat always
            stays in the foreground.
          </p>
        </div>
        <Switch
          id={enabledId}
          checked={value !== null}
          disabled={runtimeEnabled !== true && value === null}
          onCheckedChange={(checked) =>
            onChange(checked ? defaultBackgroundExecution() : null)
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
        <div className="space-y-5 rounded-md border p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="background-execution-image">
                Container image
              </Label>
              <Input
                id="background-execution-image"
                value={config.image}
                onChange={(event) => update({ image: event.target.value })}
                placeholder={BACKGROUND_EXECUTION_IMAGE_PLACEHOLDER}
              />
              <p className="text-xs text-muted-foreground">
                The deployment uses this Agent&apos;s Environment and its
                network egress policy.
              </p>
            </div>

            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="background-execution-command">Command</Label>
              <Input
                id="background-execution-command"
                value={(config.command ?? []).join(" ")}
                onChange={(event) =>
                  update({
                    command: event.target.value.trim()
                      ? event.target.value.trim().split(/\s+/)
                      : null,
                  })
                }
                placeholder="Use the image's default command"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="background-execution-steering">Steering</Label>
              <Select
                value={config.steerMode}
                onValueChange={(steerMode: "pipe" | "tmux_keys") =>
                  update({ steerMode })
                }
              >
                <SelectTrigger id="background-execution-steering">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pipe">Turn boundary</SelectItem>
                  <SelectItem value="tmux_keys">Terminal input</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="background-execution-idle-timeout">
                Idle timeout (minutes)
              </Label>
              <Input
                id="background-execution-idle-timeout"
                type="number"
                min={1}
                max={1440}
                value={config.idleTimeoutMinutes ?? ""}
                onChange={(event) => {
                  const next = event.currentTarget.valueAsNumber;
                  update({
                    idleTimeoutMinutes: Number.isFinite(next)
                      ? Math.min(1440, Math.max(1, next))
                      : null,
                  });
                }}
                placeholder="Installation default"
              />
            </div>
          </div>

          <EnvironmentEditor
            value={config.environment ?? []}
            onChange={(environment) =>
              update({ environment: environment.length ? environment : null })
            }
          />
          <CredentialsEditor
            value={config.credentials ?? []}
            onChange={(credentials) =>
              update({ credentials: credentials.length ? credentials : null })
            }
          />

          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="background-execution-privileged">
                Privileged container
              </Label>
              <p className="text-xs text-muted-foreground">
                Agent administrators only. Use when the image needs host-level
                container capabilities.
              </p>
            </div>
            <Switch
              id="background-execution-privileged"
              checked={config.privileged}
              onCheckedChange={(privileged) => update({ privileged })}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function EnvironmentEditor({
  value,
  onChange,
}: {
  value: Array<{ key: string; value: string }>;
  onChange: (value: Array<{ key: string; value: string }>) => void;
}) {
  const rowIds = useRef(value.map(() => crypto.randomUUID()));
  const rows = value.map((entry, index) => ({
    entry,
    index,
    rowId: rowIds.current[index] ?? crypto.randomUUID(),
  }));
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label>Environment variables</Label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            rowIds.current.push(crypto.randomUUID());
            onChange([...value, { key: "", value: "" }]);
          }}
        >
          <Plus className="h-4 w-4" /> Add
        </Button>
      </div>
      {rows.map(({ entry, index, rowId }) => (
        <div key={rowId} className="flex gap-2">
          <Input
            aria-label="Environment variable name"
            className="font-mono text-xs"
            value={entry.key}
            onChange={(event) =>
              onChange(
                value.map((item, itemIndex) =>
                  itemIndex === index
                    ? { ...item, key: event.target.value.toUpperCase() }
                    : item,
                ),
              )
            }
            placeholder="VARIABLE_NAME"
          />
          <Input
            aria-label="Environment variable value"
            value={entry.value}
            onChange={(event) =>
              onChange(
                value.map((item, itemIndex) =>
                  itemIndex === index
                    ? { ...item, value: event.target.value }
                    : item,
                ),
              )
            }
            placeholder="value"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Remove environment variable"
            onClick={() => {
              rowIds.current.splice(index, 1);
              onChange(value.filter((_, i) => i !== index));
            }}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
    </div>
  );
}

function CredentialsEditor({
  value,
  onChange,
}: {
  value: NonNullable<BackgroundExecutionConfig["credentials"]>;
  onChange: (
    value: NonNullable<BackgroundExecutionConfig["credentials"]>,
  ) => void;
}) {
  const rowIds = useRef(value.map(() => crypto.randomUUID()));
  const add = () => {
    rowIds.current.push(crypto.randomUUID());
    onChange([
      ...value,
      { key: "", scope: "per_user", label: "", required: true },
    ]);
  };
  const rows = value.map((entry, index) => ({
    entry,
    index,
    rowId: rowIds.current[index] ?? crypto.randomUUID(),
  }));
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <Label>Credentials</Label>
          <p className="text-xs text-muted-foreground">
            Declare values the deployment needs. Users configure personal values
            from the Agent overview; shared values use the secret manager.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={add}>
          <Plus className="h-4 w-4" /> Add
        </Button>
      </div>
      {rows.map(({ entry, index, rowId }) => {
        const update = (patch: Partial<(typeof value)[number]>) =>
          onChange(
            value.map((item, itemIndex) =>
              itemIndex === index ? { ...item, ...patch } : item,
            ),
          );
        return (
          <div key={rowId} className="space-y-2 rounded-md border p-3">
            <div className="flex gap-2">
              <Input
                aria-label="Credential environment variable"
                className="font-mono text-xs"
                value={entry.key}
                onChange={(event) =>
                  update({ key: event.target.value.toUpperCase() })
                }
                placeholder="GITHUB_TOKEN"
              />
              <Select
                value={entry.scope}
                onValueChange={(scope: "shared" | "per_user") =>
                  update({ scope })
                }
              >
                <SelectTrigger className="w-36" aria-label="Credential scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="per_user">Per user</SelectItem>
                  <SelectItem value="shared">Shared</SelectItem>
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Remove credential"
                onClick={() => {
                  rowIds.current.splice(index, 1);
                  onChange(value.filter((_, i) => i !== index));
                }}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            <Input
              aria-label="Credential label"
              value={entry.label}
              onChange={(event) => update({ label: event.target.value })}
              placeholder="GitHub token"
            />
            <Input
              aria-label="Credential instructions"
              value={entry.description ?? ""}
              onChange={(event) =>
                update({ description: event.target.value || undefined })
              }
              placeholder="How to obtain this credential"
            />
            <div className="flex items-center gap-2">
              <Checkbox
                id={`background-credential-required-${index}`}
                checked={entry.required}
                onCheckedChange={(checked) =>
                  update({ required: checked === true })
                }
              />
              <Label
                htmlFor={`background-credential-required-${index}`}
                className="text-xs font-normal text-muted-foreground"
              >
                Required before a delegated task can start
              </Label>
            </div>
          </div>
        );
      })}
    </div>
  );
}
