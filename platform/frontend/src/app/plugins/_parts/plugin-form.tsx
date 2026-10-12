"use client";

import { DEFAULT_GIT_WEB_URLS, type GitProvider } from "@archestra/shared";
import type { Ref } from "react";
import {
  ProfileLabels,
  type ProfileLabelsRef,
} from "@/components/agent-labels";
import { ResourceAccessSection } from "@/components/resource-access-section";
import {
  SettingsSection,
  SettingsSectionGroup,
} from "@/components/settings-section";
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
import { PluginContentFields } from "./plugin-content-fields";
import type { PluginDraft } from "./plugin-draft";

const SYNCED_FROM_GIT = "Synced from the repository. Change the source below.";

const GITHUB_SYNC_OPTIONS = [
  { value: "off", label: "Manual checks" },
  { value: "15m", label: "Every 15 minutes" },
  { value: "1h", label: "Every hour" },
  { value: "1d", label: "Once a day" },
] as const;

/**
 * A plugin's configuration and permissions share one draft and save action.
 *
 * One component so a plugin is filled in the same order and the same shape
 * wherever it is filled in: the create page's blank template and the plugin's
 * own page render this, differing only in the footer underneath.
 */
export function PluginForm({
  draft,
  onChange,
  labelsRef,
  readOnly = false,
  pluginSlug,
  isGithubPlugin = false,
  gitSource,
  isCreate = false,
  pluginId,
  activeSection,
}: {
  draft: PluginDraft;
  onChange: (patch: Partial<PluginDraft>) => void;
  labelsRef?: Ref<ProfileLabelsRef>;
  /** The plugin is not this reader's to change. */
  readOnly?: boolean;
  /** The immutable identity a saved plugin keeps across renames. */
  pluginSlug?: string;
  /**
   * The files belong to a repository. The payload is shown but locked, and
   * the source that owns it becomes editable in its place.
   */
  isGithubPlugin?: boolean;
  /** The source's host and the credentials it can be read with. */
  gitSource?: GitSourceOptions;
  /** Client type is part of a plugin's identity, so it is set once, at create. */
  isCreate?: boolean;
  /**
   * The saved plugin whose access policy this form edits.
   *
   * Access is a grant now. A saved plugin answers "who can reach this" from
   * its own policy, so the form shows that policy rather than the retired
   * visibility fields, which nothing reads once the plugin has converted.
   */
  pluginId?: string;
  activeSection: "general" | "permissions";
}) {
  return (
    <>
      {activeSection === "general" ? (
        <SettingsSectionGroup>
          {/* No heading: the page header already names the plugin, and the fields
          — Display name, Description, the payload — say what they are. */}
          <SettingsSection>
            <PluginContentFields
              displayName={draft.displayName}
              onDisplayNameChange={(displayName) => onChange({ displayName })}
              description={draft.description}
              onDescriptionChange={(description) => onChange({ description })}
              clientType={isCreate ? draft.clientType : undefined}
              onClientTypeChange={
                isCreate ? (clientType) => onChange({ clientType }) : undefined
              }
              pluginSlug={pluginSlug}
              platforms={draft.supportedPlatforms}
              onPlatformsChange={(supportedPlatforms) =>
                onChange({ supportedPlatforms })
              }
              files={draft.files}
              onFilesChange={(files) => onChange({ files })}
              readOnly={readOnly || isGithubPlugin}
              readOnlyReason={isGithubPlugin ? SYNCED_FROM_GIT : undefined}
            />
          </SettingsSection>

          {/* Under the payload it governs, not above it: the fields on this panel
          are the answer to "these are read-only — where do I change them?",
          so they read best straight after the question. */}
          {isGithubPlugin && (
            <SettingsSection
              title="Source"
              description="Where these files come from, and how often to check."
            >
              <GitSourceFields
                draft={draft}
                onChange={onChange}
                source={gitSource ?? { provider: "github", credentials: [] }}
              />
            </SettingsSection>
          )}

          <SettingsSection>
            <fieldset disabled={readOnly}>
              <ProfileLabels
                ref={labelsRef}
                labels={draft.labels}
                onLabelsChange={(labels) => onChange({ labels })}
              />
            </fieldset>
          </SettingsSection>
        </SettingsSectionGroup>
      ) : (
        <fieldset disabled={readOnly}>
          <ResourceAccessSection
            resource="plugin"
            id={pluginId}
            grants={draft.initialGrants}
            onGrantsChange={(initialGrants) => onChange({ initialGrants })}
            standalone
          />
        </fieldset>
      )}
    </>
  );
}

export interface GitSourceOptions {
  provider: GitProvider;
  /** `value` is the draft's `gitCredential` encoding. */
  credentials: { value: string; label: string }[];
}

/** Where a Git-sourced plugin's files come from, and how often it looks. */
function GitSourceFields({
  draft,
  onChange,
  source,
}: {
  draft: PluginDraft;
  onChange: (patch: Partial<PluginDraft>) => void;
  source: GitSourceOptions;
}) {
  const host = new URL(DEFAULT_GIT_WEB_URLS[source.provider]).host;
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="plugin-github-repo-url">Repository URL</Label>
        <Input
          id="plugin-github-repo-url"
          value={draft.githubRepoUrl}
          onChange={(event) => onChange({ githubRepoUrl: event.target.value })}
          placeholder={
            source.provider === "gitlab"
              ? `${host}/group/project`
              : `${host}/owner/repo`
          }
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="plugin-git-credential">Access</Label>
          <Select
            value={draft.gitCredential || PUBLIC_ACCESS}
            onValueChange={(value) =>
              onChange({
                gitCredential: value === PUBLIC_ACCESS ? "" : value,
              })
            }
          >
            <SelectTrigger id="plugin-git-credential" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {source.credentials.map((credential) => (
                <SelectItem key={credential.value} value={credential.value}>
                  {credential.label}
                </SelectItem>
              ))}
              <SelectItem value={PUBLIC_ACCESS}>
                {source.provider === "gitlab"
                  ? "Public project"
                  : "Public repository"}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="plugin-github-sync-ref">Branch</Label>
          <Input
            id="plugin-github-sync-ref"
            value={draft.githubSyncRef}
            onChange={(event) =>
              onChange({ githubSyncRef: event.target.value })
            }
            placeholder="Default branch"
            autoComplete="off"
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="plugin-github-sync-interval">Keep in sync</Label>
        <FieldDescription>New commits wait for your review.</FieldDescription>
        <Select
          value={draft.githubSyncInterval ?? "off"}
          onValueChange={(value) =>
            onChange({
              githubSyncInterval:
                value === "off" ? null : (value as "15m" | "1h" | "1d"),
            })
          }
        >
          <SelectTrigger id="plugin-github-sync-interval" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GITHUB_SYNC_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

const PUBLIC_ACCESS = "public";
