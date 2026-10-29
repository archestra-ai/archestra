"use client";

import { Info } from "lucide-react";
import { IdentityFields } from "@/components/identity-fields";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SingleSelectCombobox } from "@/components/ui/single-select-combobox";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
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
  | "claude-desktop"
  | "copilot-cli"
  | "codex"
  | "cursor";

/**
 * The wizard's Content step, shared by the create and edit wizards: the
 * plugin's metadata beside its payload files. Client type is create-only
 * (it is part of the plugin's identity), and the slug, shown as a hint on the
 * name, is edit-only.
 */
export function PluginContentFields({
  displayName,
  onDisplayNameChange,
  icon,
  onIconChange,
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
  locked = false,
}: {
  displayName: string;
  onDisplayNameChange: (value: string) => void;
  icon: string | null;
  onIconChange: (value: string | null) => void;
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
   * The content belongs to the plugin's Git source: shown disabled, so it
   * reads as locked rather than as fields that ignore typing.
   */
  locked?: boolean;
}) {
  return (
    <div className="space-y-6">
      <section className="space-y-4">
        {/* The icon is Archestra's, not the repository's: it stays editable
            while the name is locked to the source. */}
        <IdentityFields
          icon={icon}
          onIconChange={onIconChange}
          fallbackType="plugin"
          disabled={readOnly}
          label={
            <div className="flex items-center gap-1.5">
              <Label htmlFor="plugin-display-name">Display name</Label>
              {pluginSlug ? <PluginIdentityHint slug={pluginSlug} /> : null}
            </div>
          }
        >
          <Input
            id="plugin-display-name"
            value={displayName}
            readOnly={readOnly}
            disabled={locked}
            onChange={(event) => onDisplayNameChange(event.target.value)}
            placeholder="Session attribution"
            maxLength={120}
            required
          />
        </IdentityFields>
        <div className="space-y-2">
          <Label htmlFor="plugin-description">Description</Label>
          <Textarea
            id="plugin-description"
            value={description}
            readOnly={readOnly}
            disabled={locked}
            onChange={(event) => onDescriptionChange(event.target.value)}
            placeholder="What this plugin does."
            maxLength={1000}
            rows={3}
          />
        </div>
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
        <PluginPlatforms
          value={platforms}
          onChange={onPlatformsChange}
          disabled={readOnly || locked}
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
        readOnly={readOnly || locked}
        className="h-[calc(100vh-26rem)] min-h-[28rem]"
      />
    </div>
  );
}

const PLUGIN_CLIENT_OPTIONS = [
  ["claude-code", "Claude Code"],
  ["claude-desktop", "Claude Desktop"],
  ["copilot-cli", "Copilot CLI"],
  ["codex", "Codex"],
  ["cursor", "Cursor (advertised only)"],
].map(([value, label]) => ({
  value: value as PluginClientType,
  label,
  icon: <PluginClientIcon clientType={value as PluginClientType} size={18} />,
}));

/**
 * The name clients install the plugin by. It never changes, so it is a hint
 * on the name rather than a field: there is nothing to edit.
 */
function PluginIdentityHint({ slug }: { slug: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          type="button"
          aria-label={`Plugin identity: ${slug}`}
          className="text-muted-foreground hover:text-foreground"
        >
          <Info className="size-3.5" />
        </UnstyledButton>
      </TooltipTrigger>
      {/* Short enough for one line: a wrapped, balanced paragraph leaves the
          box at its max width with dead space beside the lines. */}
      <TooltipContent>
        <p className="font-medium">Plugin identity</p>
        <p className="font-mono">{slug}</p>
        <p className="opacity-80">Clients install by it. Renaming keeps it.</p>
      </TooltipContent>
    </Tooltip>
  );
}
