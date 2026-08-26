"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { Plus, Trash2 } from "lucide-react";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
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

// The generated client inlines this shape rather than naming it, so it is
// derived from the create-agent body instead of restated here.
type RunnerConfig = NonNullable<
  archestraApiTypes.CreateAgentData["body"]["runnerConfig"]
>;
type CredentialDeclaration = NonNullable<RunnerConfig["credentials"]>[number];

interface RunnerConfigSectionProps {
  value: RunnerConfig | null;
  onChange: (value: RunnerConfig | null) => void;
  /** Only an administrator may grant a runner host-level privileges. */
  canConfigurePrivileged: boolean;
}

/**
 * What a long-running session for this agent starts from.
 *
 * An agent without this cannot be run as a Runner at all, which is why the
 * whole section is behind one switch rather than a scattering of empty fields.
 */
export function RunnerConfigSection({
  value,
  onChange,
  canConfigurePrivileged,
}: RunnerConfigSectionProps) {
  const enabled = value !== null;
  const credentials = value?.credentials ?? [];
  // A credential's key starts empty and is typed character by character, so it
  // cannot identify its own row. These ids are per-row and never persisted.
  const rowIds = useRef<string[]>([]);
  while (rowIds.current.length < credentials.length) {
    rowIds.current.push(crypto.randomUUID());
  }

  const update = (patch: Partial<RunnerConfig>) => {
    onChange({ ...(value ?? {}), ...patch });
  };

  const updateCredential = (
    index: number,
    patch: Partial<CredentialDeclaration>,
  ) => {
    const next = credentials.map(
      (entry: CredentialDeclaration, position: number) =>
        position === index ? { ...entry, ...patch } : entry,
    );
    update({ credentials: next });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="runner-enabled" className="text-sm font-medium">
            Runner
          </Label>
          <p className="text-sm text-muted-foreground">
            Let this agent run as a long-running session in its own container,
            which you can attach to and steer while it works.
          </p>
        </div>
        <Switch
          id="runner-enabled"
          checked={enabled}
          onCheckedChange={(checked) =>
            onChange(checked ? { credentials: [], environment: [] } : null)
          }
        />
      </div>

      {enabled && (
        <div className="space-y-4 rounded-md border p-3">
          <div className="space-y-1.5">
            <Label htmlFor="runner-image">Image</Label>
            <Input
              id="runner-image"
              value={value?.image ?? ""}
              placeholder="Leave empty for the Archestra runner agent"
              onChange={(event) =>
                update({ image: event.target.value || undefined })
              }
            />
            <p className="text-xs text-muted-foreground">
              Any image with tmux and a shell. The default runs Archestra's own
              agent loop.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="runner-command">Command</Label>
            <Input
              id="runner-command"
              value={(value?.command ?? []).join(" ")}
              placeholder="Leave empty to run the image's agent"
              onChange={(event) => {
                const parts = event.target.value
                  .trim()
                  .split(/\s+/)
                  .filter(Boolean);
                update({ command: parts.length > 0 ? parts : undefined });
              }}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="runner-steer-mode">Steering</Label>
              <Select
                value={value?.steerMode ?? "pipe"}
                onValueChange={(next) =>
                  update({ steerMode: next as RunnerConfig["steerMode"] })
                }
              >
                <SelectTrigger id="runner-steer-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pipe">
                    At a turn boundary (Archestra agent)
                  </SelectItem>
                  <SelectItem value="tmux_keys">
                    Typed into the session (other CLIs)
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="runner-ttl">Lifetime (hours)</Label>
              <Input
                id="runner-ttl"
                type="number"
                min={1}
                value={value?.ttlHours ?? ""}
                placeholder="Deployment default"
                onChange={(event) =>
                  update({
                    ttlHours: event.target.value
                      ? Number(event.target.value)
                      : undefined,
                  })
                }
              />
            </div>
          </div>

          {canConfigurePrivileged && (
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label
                  htmlFor="runner-privileged"
                  className="text-sm font-medium"
                >
                  Privileged container
                </Label>
                <p className="text-xs text-muted-foreground">
                  Needed only by images that run their own container runtime.
                  This is node-level access — grant it deliberately.
                </p>
              </div>
              <Switch
                id="runner-privileged"
                checked={value?.privileged ?? false}
                onCheckedChange={(checked) => update({ privileged: checked })}
              />
            </div>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="space-y-0.5">
                <Label>Credentials</Label>
                <p className="text-xs text-muted-foreground">
                  Shared values come from this agent. Per-user values come from
                  whoever starts the runner, for tokens that carry a person's
                  own identity — they are asked for them once.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  update({
                    credentials: [
                      ...credentials,
                      {
                        key: "",
                        scope: "per_user",
                        label: "",
                        required: true,
                      },
                    ],
                  })
                }
              >
                <Plus className="h-3 w-3" /> Add
              </Button>
            </div>

            {credentials.map(
              (credential: CredentialDeclaration, index: number) => (
                <div
                  // Index is the identity here: a key field starts empty and is
                  // edited character by character, so it cannot address the row.
                  key={rowIds.current[index]}
                  className="grid grid-cols-[1fr_1fr_auto] gap-2 items-start"
                >
                  <Input
                    value={credential.key}
                    placeholder="CLAUDE_CODE_OAUTH_TOKEN"
                    onChange={(event) =>
                      updateCredential(index, {
                        key: event.target.value.toUpperCase(),
                      })
                    }
                  />
                  <div className="flex gap-2">
                    <Input
                      value={credential.label}
                      placeholder="Claude Code token"
                      onChange={(event) =>
                        updateCredential(index, { label: event.target.value })
                      }
                    />
                    <Select
                      value={credential.scope}
                      onValueChange={(next) =>
                        updateCredential(index, {
                          scope: next as CredentialDeclaration["scope"],
                        })
                      }
                    >
                      <SelectTrigger className="w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="per_user">Per user</SelectItem>
                        <SelectItem value="shared">Shared</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      update({
                        credentials: credentials.filter(
                          (_: CredentialDeclaration, position: number) =>
                            position !== index,
                        ),
                      })
                    }
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ),
            )}
          </div>
        </div>
      )}
    </div>
  );
}
