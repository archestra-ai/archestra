"use client";

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { type ProfileLabel, ProfileLabels } from "@/components/agent-labels";
import { EnvironmentSelector } from "@/components/environment-selector";
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
import { Textarea } from "@/components/ui/textarea";
import type { Runner } from "@/lib/runners.query";

export const DEFAULT_RUNNER_IMAGE = "ghcr.io/archestra-ai/runner-agent:latest";

export type CredentialDraft = {
  /** Stable across edits; `key` is what the user is still typing. */
  id: string;
  key: string;
  scope: "shared" | "per_user";
  label: string;
  description: string;
  required: boolean;
};

export type RunnerFormState = ReturnType<typeof useRunnerForm>;

/**
 * One runner's editable state, shared by the create and edit wizards so the
 * two cannot drift in what they collect or how they serialize it.
 */
export function useRunnerForm(runner?: Runner | null) {
  const [name, setName] = useState(runner?.name ?? "");
  const [description, setDescription] = useState(runner?.description ?? "");
  const [image, setImage] = useState(runner?.image ?? DEFAULT_RUNNER_IMAGE);
  const [command, setCommand] = useState((runner?.command ?? []).join(" "));
  const [steerMode, setSteerMode] = useState<"pipe" | "tmux_keys">(
    runner?.steerMode ?? "pipe",
  );
  const [environmentId, setEnvironmentId] = useState<string | null>(
    runner?.environmentId ?? null,
  );
  const [labels, setLabels] = useState<ProfileLabel[]>(
    (runner?.labels ?? []).map((label) => ({
      key: label.key,
      value: label.value,
    })),
  );
  const [credentials, setCredentials] = useState<CredentialDraft[]>(
    (runner?.credentials ?? []).map((entry) => ({
      id: crypto.randomUUID(),
      key: entry.key,
      scope: entry.scope,
      label: entry.label,
      description: entry.description ?? "",
      required: entry.required,
    })),
  );

  return {
    name,
    setName,
    description,
    setDescription,
    image,
    setImage,
    command,
    setCommand,
    steerMode,
    setSteerMode,
    environmentId,
    setEnvironmentId,
    labels,
    setLabels,
    credentials,
    setCredentials,
    /** Whether the first step holds enough to go on. */
    canContinue: name.trim().length > 0 && image.trim().length > 0,
    toBody() {
      return {
        name: name.trim(),
        description: description.trim() || null,
        image: image.trim(),
        command: command.trim() ? command.trim().split(/\s+/) : null,
        steerMode,
        environmentId,
        labels: labels
          .filter((label) => label.key && label.value)
          .map((label) => ({ key: label.key, value: label.value })),
        credentials: credentials
          .filter((entry) => entry.key && entry.label)
          .map((entry) => ({
            key: entry.key,
            scope: entry.scope,
            label: entry.label,
            description: entry.description || undefined,
            required: entry.required,
          })),
      };
    },
  };
}

/** Step 1: what the container is. */
export function RunnerConfigurationFields({ form }: { form: RunnerFormState }) {
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="runner-name">Name</Label>
        <Input
          id="runner-name"
          value={form.name}
          onChange={(event) => form.setName(event.target.value)}
          placeholder="claude-code"
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="runner-description">Description</Label>
        <Textarea
          id="runner-description"
          value={form.description}
          onChange={(event) => form.setDescription(event.target.value)}
          placeholder="What this runner is for"
          rows={2}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="runner-image">Image</Label>
        <Input
          id="runner-image"
          value={form.image}
          onChange={(event) => form.setImage(event.target.value)}
          placeholder={DEFAULT_RUNNER_IMAGE}
          required
        />
        <p className="text-xs text-muted-foreground">
          Bring your own image, or keep the default Archestra agent runtime.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="runner-command">Command</Label>
        <Input
          id="runner-command"
          value={form.command}
          onChange={(event) => form.setCommand(event.target.value)}
          placeholder="Leave empty to use the image's own entrypoint"
        />
      </div>
    </div>
  );
}

/** Step 2: how a session behaves once it is running. */
export function RunnerExecutionFields({ form }: { form: RunnerFormState }) {
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="runner-steer-mode">Steering</Label>
        <Select
          value={form.steerMode}
          onValueChange={(value) =>
            form.setSteerMode(value as "pipe" | "tmux_keys")
          }
        >
          <SelectTrigger id="runner-steer-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="pipe">
              Pipe — injected at the next turn boundary
            </SelectItem>
            <SelectItem value="tmux_keys">
              tmux keys — typed into the session
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          How an interjection reaches the process. Pipe can never land
          mid-tool-call; tmux keys suit CLIs that own their own input loop.
        </p>
      </div>

      <EnvironmentSelector
        value={form.environmentId}
        onChange={form.setEnvironmentId}
        resource="runner"
        helpText="Sessions on this runner inherit the environment's network egress rules."
      />
    </div>
  );
}

/** Step 3: labels and the credentials a session needs. */
export function RunnerAccessFields({ form }: { form: RunnerFormState }) {
  return (
    <div className="space-y-6">
      <ProfileLabels labels={form.labels} onLabelsChange={form.setLabels} />
      <CredentialsEditor
        credentials={form.credentials}
        onChange={form.setCredentials}
      />
    </div>
  );
}

/**
 * Declares what the runner needs to do its job. `shared` values come from the
 * organization's bag; `per_user` ones are supplied by each person who runs the
 * agent, which is what lets a session act as them upstream.
 */
function CredentialsEditor({
  credentials,
  onChange,
}: {
  credentials: CredentialDraft[];
  onChange: (credentials: CredentialDraft[]) => void;
}) {
  const update = (index: number, patch: Partial<CredentialDraft>) => {
    onChange(
      credentials.map((entry, i) =>
        i === index ? { ...entry, ...patch } : entry,
      ),
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>Credentials</Label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            onChange([
              ...credentials,
              {
                id: crypto.randomUUID(),
                key: "",
                scope: "per_user",
                label: "",
                description: "",
                required: true,
              },
            ])
          }
        >
          <Plus className="h-4 w-4" />
          Add
        </Button>
      </div>

      {credentials.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          None declared. Add one to have Archestra inject it as an environment
          variable — and to prompt users for their own where the credential
          carries their identity.
        </p>
      ) : null}

      {credentials.map((entry, index) => (
        <div key={entry.id} className="space-y-2 rounded-md border p-3">
          <div className="flex items-start gap-2">
            <Input
              value={entry.key}
              onChange={(event) =>
                update(index, { key: event.target.value.toUpperCase() })
              }
              placeholder="CLAUDE_CODE_OAUTH_TOKEN"
              className="font-mono text-xs"
              aria-label="Environment variable"
            />
            <Select
              value={entry.scope}
              onValueChange={(value) =>
                update(index, { scope: value as "shared" | "per_user" })
              }
            >
              <SelectTrigger className="w-[9.5rem]" aria-label="Scope">
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
              size="sm"
              onClick={() =>
                onChange(credentials.filter((_, i) => i !== index))
              }
              aria-label="Remove credential"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
          <Input
            value={entry.label}
            onChange={(event) => update(index, { label: event.target.value })}
            placeholder="Claude Code OAuth token"
            aria-label="Label"
          />
          <Input
            value={entry.description}
            onChange={(event) =>
              update(index, { description: event.target.value })
            }
            placeholder="Run `claude setup-token` and paste the result"
            aria-label="How to obtain it"
          />
          <div className="flex items-center gap-2">
            <Checkbox
              id={`credential-required-${entry.id}`}
              checked={entry.required}
              onCheckedChange={(value) =>
                update(index, { required: value === true })
              }
            />
            <Label
              htmlFor={`credential-required-${entry.id}`}
              className="text-xs font-normal text-muted-foreground"
            >
              Required to start a session
            </Label>
          </div>
        </div>
      ))}
    </div>
  );
}
