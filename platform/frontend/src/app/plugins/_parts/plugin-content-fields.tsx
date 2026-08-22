"use client";

import { Input } from "@/components/ui/input";
import { SingleSelectCombobox } from "@/components/ui/single-select-combobox";
import { Textarea } from "@/components/ui/textarea";
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
}) {
  return (
    <div className="space-y-6">
      <section className="grid gap-5 md:grid-cols-2">
        <label htmlFor="plugin-display-name" className="space-y-2">
          <span className="text-sm font-medium">Display name</span>
          <Input
            id="plugin-display-name"
            value={displayName}
            readOnly={readOnly}
            onChange={(event) => onDisplayNameChange(event.target.value)}
            placeholder="Session attribution"
            maxLength={120}
            required
          />
        </label>
        {onClientTypeChange && clientType ? (
          <label htmlFor="plugin-client-type" className="space-y-2">
            <span className="text-sm font-medium">Target client</span>
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
          </label>
        ) : null}
        {pluginSlug ? (
          <label htmlFor="plugin-slug" className="space-y-2">
            <span className="text-sm font-medium">Plugin identity</span>
            <Input
              id="plugin-slug"
              value={pluginSlug}
              readOnly
              className="font-mono text-xs"
            />
            <span className="block text-xs text-muted-foreground">
              Frozen so renaming the plugin cannot orphan installed plugins.
            </span>
          </label>
        ) : null}
        <label htmlFor="plugin-description" className="space-y-2 md:col-span-2">
          <span className="text-sm font-medium">Description</span>
          <Textarea
            id="plugin-description"
            value={description}
            readOnly={readOnly}
            onChange={(event) => onDescriptionChange(event.target.value)}
            placeholder="What this plugin does and when an administrator should deploy it"
            maxLength={1000}
            rows={3}
          />
        </label>
        <PluginPlatforms
          value={platforms}
          onChange={onPlatformsChange}
          disabled={readOnly}
        />
      </section>

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
    </div>
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
