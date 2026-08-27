"use client";

import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { type ProfileLabel, ProfileLabels } from "@/components/agent-labels";
import { EnvironmentSelector } from "@/components/environment-selector";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogForm, DialogStickyFooter } from "@/components/ui/dialog";
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
import {
  type Runner,
  useCreateRunner,
  useUpdateRunner,
} from "@/lib/runners.query";

type CredentialDraft = {
  /** Stable across edits; the `key` field is what the user is still typing. */
  id: string;
  key: string;
  scope: "shared" | "per_user";
  label: string;
  description: string;
  required: boolean;
};

const DEFAULT_IMAGE = "ghcr.io/archestra-ai/runner-agent:latest";

export function RunnerDialog({
  open,
  onOpenChange,
  runner,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null creates; a runner edits it. */
  runner: Runner | null;
}) {
  const create = useCreateRunner();
  const update = useUpdateRunner();
  const isPending = create.isPending || update.isPending;

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [image, setImage] = useState(DEFAULT_IMAGE);
  const [command, setCommand] = useState("");
  const [steerMode, setSteerMode] = useState<"pipe" | "tmux_keys">("pipe");
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const [labels, setLabels] = useState<ProfileLabel[]>([]);
  const [credentials, setCredentials] = useState<CredentialDraft[]>([]);

  // Reset to the runner being edited each time the dialog opens, so a cancelled
  // edit never leaks into the next one.
  useEffect(() => {
    if (!open) return;
    setName(runner?.name ?? "");
    setDescription(runner?.description ?? "");
    setImage(runner?.image ?? DEFAULT_IMAGE);
    setCommand((runner?.command ?? []).join(" "));
    setSteerMode(runner?.steerMode ?? "pipe");
    setEnvironmentId(runner?.environmentId ?? null);
    setLabels(
      (runner?.labels ?? []).map((label) => ({
        key: label.key,
        value: label.value,
      })),
    );
    setCredentials(
      (runner?.credentials ?? []).map((entry) => ({
        id: crypto.randomUUID(),
        key: entry.key,
        scope: entry.scope,
        label: entry.label,
        description: entry.description ?? "",
        required: entry.required,
      })),
    );
  }, [open, runner]);

  const handleSubmit = async () => {
    const body = {
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

    if (runner) {
      await update.mutateAsync({ id: runner.id, body });
    } else {
      await create.mutateAsync(body);
    }
    onOpenChange(false);
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={runner ? `Edit ${runner.name}` : "Create Runner"}
      description="A runner is a pod spec: the image an agent's long-running work executes in, the credentials it needs, and the environment whose egress rules apply."
      size="large"
    >
      <DialogForm
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (isPending) return;
          void handleSubmit();
        }}
      >
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-1 py-2">
          <div className="space-y-2">
            <Label htmlFor="runner-name">Name</Label>
            <Input
              id="runner-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="claude-code"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="runner-description">Description</Label>
            <Textarea
              id="runner-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What this runner is for"
              rows={2}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="runner-image">Image</Label>
            <Input
              id="runner-image"
              value={image}
              onChange={(event) => setImage(event.target.value)}
              placeholder={DEFAULT_IMAGE}
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
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="Leave empty to use the image's own entrypoint"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="runner-steer-mode">Steering</Label>
            <Select
              value={steerMode}
              onValueChange={(value) =>
                setSteerMode(value as "pipe" | "tmux_keys")
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
            value={environmentId}
            onChange={setEnvironmentId}
            resource="runner"
            helpText="Sessions on this runner inherit the environment's network egress rules."
          />

          <ProfileLabels labels={labels} onLabelsChange={setLabels} />

          <CredentialsEditor
            credentials={credentials}
            onChange={setCredentials}
          />
        </div>

        <DialogStickyFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={isPending || !name.trim()}>
            {isPending ? "Saving..." : runner ? "Save" : "Create Runner"}
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
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
