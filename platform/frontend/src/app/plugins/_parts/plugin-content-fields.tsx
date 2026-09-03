"use client";

import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SingleSelectCombobox } from "@/components/ui/single-select-combobox";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SkillContentEditor } from "../../skills/_parts/skill-content-editor";
import { PluginClientIcon } from "./plugin-client-icon";
import { type PluginPlatform, PluginPlatforms } from "./plugin-platforms";

export interface PluginFileDraft {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
  mode: "100644" | "100755";
}

export type PluginClientType =
  | "claude-code"
  | "copilot-cli"
  | "codex"
  | "cursor";

/**
 * The wizard's Content step, shared by the create and edit wizards: the
 * plugin's metadata beside its payload files. Client type is create-only
 * (it is part of the plugin's identity), and the slug is edit-only.
 */
export function PluginContentFields({
  displayName,
  onDisplayNameChange,
  description,
  onDescriptionChange,
  clientType,
  onClientTypeChange,
  pluginSlug,
  platforms,
  onPlatformsChange,
  files,
  onFilesChange,
  readOnly = false,
  readOnlyReason,
}: {
  displayName: string;
  onDisplayNameChange: (value: string) => void;
  description: string;
  onDescriptionChange: (value: string) => void;
  clientType?: PluginClientType;
  onClientTypeChange?: (value: PluginClientType) => void;
  pluginSlug?: string;
  platforms: PluginPlatform[];
  onPlatformsChange: (value: PluginPlatform[]) => void;
  files: PluginFileDraft[];
  onFilesChange: (value: PluginFileDraft[]) => void;
  /** Everything is frozen (viewer without update permission). */
  readOnly?: boolean;
  /**
   * Why the fields refuse to be typed into, shown on the field the reader
   * tried to change. A control that silently ignores keystrokes reads as
   * broken, and the reason is only useful where the attempt happened — so it
   * hangs off each locked field rather than off the panel around them, which
   * put the tooltip halfway up the page.
   */
  readOnlyReason?: string;
}) {
  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <Locked reason={readOnlyReason}>
          <div className="space-y-2">
            <Label htmlFor="plugin-display-name">Display name</Label>
            <Input
              id="plugin-display-name"
              value={displayName}
              readOnly={readOnly}
              onChange={(event) => onDisplayNameChange(event.target.value)}
              placeholder="Session attribution"
              maxLength={120}
              required
            />
          </div>
        </Locked>
        <Locked reason={readOnlyReason}>
          <div className="space-y-2">
            <Label htmlFor="plugin-description">Description</Label>
            <Textarea
              id="plugin-description"
              value={description}
              readOnly={readOnly}
              onChange={(event) => onDescriptionChange(event.target.value)}
              placeholder="What this plugin does."
              maxLength={1000}
              rows={3}
            />
          </div>
        </Locked>
        {pluginSlug ? (
          <div className="space-y-2">
            <Label htmlFor="plugin-slug">Plugin identity</Label>
            <Input
              id="plugin-slug"
              value={pluginSlug}
              readOnly
              className="font-mono text-xs"
            />
            <span className="block text-xs text-muted-foreground">
              This name stays after you rename the plugin.
            </span>
          </div>
        ) : null}
        {onClientTypeChange && clientType ? (
          <div className="space-y-2">
            <Label htmlFor="plugin-client-type">Target client</Label>
            <SingleSelectCombobox
              id="plugin-client-type"
              value={clientType}
              onChange={(value) =>
                onClientTypeChange(value as PluginClientType)
              }
              options={PLUGIN_CLIENT_OPTIONS}
              searchPlaceholder="Search clients..."
              disabled={readOnly}
            />
          </div>
        ) : null}
        <Locked reason={readOnlyReason}>
          <PluginPlatforms
            value={platforms}
            onChange={onPlatformsChange}
            disabled={readOnly}
          />
        </Locked>
      </section>

      <Locked reason={readOnlyReason}>
        <SkillContentEditor
          manifest={null}
          files={files.map(({ path, content, encoding }) => ({
            path,
            content,
            encoding,
          }))}
          onManifestChange={() => {}}
          onFilesChange={(update) => {
            const next = update(files);
            const modesByPath = new Map(
              files.map((file) => [file.path, file.mode]),
            );
            onFilesChange(
              next.map((file, index) => ({
                ...file,
                mode:
                  modesByPath.get(file.path) ?? files[index]?.mode ?? "100644",
              })),
            );
          }}
          readOnly={readOnly}
          className="h-[calc(100vh-26rem)] min-h-[28rem]"
        />
      </Locked>
    </div>
  );
}

/**
 * One locked field, with the reason on it. `reason` undefined means the field
 * is editable and the wrapper disappears entirely, so an editable form carries
 * no tooltip machinery at all.
 */
function Locked({
  reason,
  children,
}: {
  reason?: string;
  children: ReactNode;
}) {
  if (!reason) return children;
  return (
    <TooltipProvider>
      <Tooltip>
        {/* The field itself is the trigger, so the tooltip opens beside what
            the reader tried to type into. Focus bubbles out of the control
            inside, so tabbing to it shows the reason too. */}
        <TooltipTrigger asChild>
          <div className="flex min-h-0 flex-col">{children}</div>
        </TooltipTrigger>
        <TooltipContent side="top" align="start" className="max-w-xs">
          {reason}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

const PLUGIN_CLIENT_OPTIONS = [
  ["claude-code", "Claude Code"],
  ["copilot-cli", "Copilot CLI"],
  ["codex", "Codex"],
  ["cursor", "Cursor (advertised only)"],
].map(([value, label]) => ({
  value: value as PluginClientType,
  label,
  icon: <PluginClientIcon clientType={value as PluginClientType} size={18} />,
}));
