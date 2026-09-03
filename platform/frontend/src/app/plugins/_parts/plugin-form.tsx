"use client";

import type { ReactNode, Ref } from "react";
import {
  ProfileLabels,
  type ProfileLabelsRef,
} from "@/components/agent-labels";
import { GithubAuthConfigFields } from "@/components/github-auth-config-fields";
import { FieldDescription } from "@/components/ui/field-description";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SecretInput } from "@/components/ui/secret-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { typeRole } from "@/lib/design/type-scale";
import { PluginContentFields } from "./plugin-content-fields";
import type { PluginDraft } from "./plugin-draft";
import { PluginScopeSelector } from "./plugin-scope-selector";

const SYNCED_FROM_GITHUB =
  "These values are synced from GitHub. Change sync settings below.";

const GITHUB_SYNC_OPTIONS = [
  { value: "off", label: "Manual checks" },
  { value: "15m", label: "Every 15 minutes" },
  { value: "1h", label: "Every hour" },
  { value: "1d", label: "Once a day" },
] as const;

/**
 * Everything a plugin is, on one page: what it installs — its own files, or
 * the GitHub source they are pulled from — and, at the end, who can discover
 * it and how it is labelled.
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
  githubAppConfigs,
  isCreate = false,
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
  githubAppConfigs?: { id: string; name: string }[];
  /** Client type is part of a plugin's identity, so it is set once, at create. */
  isCreate?: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      {/* No heading: the page header already names the plugin, and the fields
          — Display name, Description, the payload — say what they are. */}
      <FormPanel>
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
          readOnlyReason={isGithubPlugin ? SYNCED_FROM_GITHUB : undefined}
        />
      </FormPanel>

      {/* Under the payload it governs, not above it: the fields on this panel
          are the answer to "these are read-only — where do I change them?",
          so they read best straight after the question. */}
      {isGithubPlugin && (
        <FormPanel title="GitHub source">
          <GithubSourceFields
            draft={draft}
            onChange={onChange}
            githubAppConfigs={githubAppConfigs ?? []}
          />
        </FormPanel>
      )}

      <FormPanel title="Access">
        <fieldset disabled={readOnly} className="contents">
          <PluginScopeSelector
            scope={draft.scope}
            onScopeChange={(scope) => onChange({ scope })}
            teamIds={draft.teamIds}
            onTeamIdsChange={(teamIds) => onChange({ teamIds })}
            userIds={draft.userIds}
            onUserIdsChange={(userIds) => onChange({ userIds })}
          />
          <ProfileLabels
            ref={labelsRef}
            labels={draft.labels}
            onLabelsChange={(labels) => onChange({ labels })}
          />
        </fieldset>
      </FormPanel>
    </div>
  );
}

/** Where a GitHub-sourced plugin's files come from, and how often it looks. */
function GithubSourceFields({
  draft,
  onChange,
  githubAppConfigs,
}: {
  draft: PluginDraft;
  onChange: (patch: Partial<PluginDraft>) => void;
  githubAppConfigs: { id: string; name: string }[];
}) {
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="plugin-github-repo-url">Repository URL</Label>
        <FieldDescription>
          The GitHub repository checked for plugin updates.
        </FieldDescription>
        <Input
          id="plugin-github-repo-url"
          value={draft.githubRepoUrl}
          onChange={(event) => onChange({ githubRepoUrl: event.target.value })}
          placeholder="github.com/owner/repo"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="plugin-github-sync-interval">Keep in sync</Label>
        <FieldDescription>
          New commits become review candidates and never replace approved plugin
          bytes automatically.
        </FieldDescription>
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
      <GithubAuthConfigFields
        authMethod={draft.githubAuthMethod}
        onAuthMethodChange={(githubAuthMethod) =>
          onChange({
            githubAuthMethod,
            ...(githubAuthMethod === "pat" ? { githubAppConfigId: "" } : {}),
          })
        }
        githubAppConfigId={draft.githubAppConfigId}
        onGithubAppConfigIdChange={(githubAppConfigId) =>
          onChange({ githubAppConfigId })
        }
        githubAppConfigs={githubAppConfigs}
        patFields={
          <div className="space-y-2">
            <Label htmlFor="plugin-github-token">Personal Access Token</Label>
            <FieldDescription>
              <span>Leave empty to keep existing credentials unchanged.</span>{" "}
              <span>
                Fine-grained or classic — see{" "}
                <a
                  href="https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens"
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-primary underline-offset-4 hover:underline"
                >
                  managing your personal access tokens
                </a>
                .
              </span>
            </FieldDescription>
            <SecretInput
              id="plugin-github-token"
              value={draft.githubToken}
              onChange={(event) =>
                onChange({ githubToken: event.target.value })
              }
              placeholder="Leave empty to keep existing token"
            />
          </div>
        }
      />
      <div className="space-y-2">
        <Label htmlFor="plugin-github-sync-ref">Ref</Label>
        <FieldDescription>
          Leave empty to track the repository&apos;s default branch.
        </FieldDescription>
        <Input
          id="plugin-github-sync-ref"
          value={draft.githubSyncRef}
          onChange={(event) => onChange({ githubSyncRef: event.target.value })}
          placeholder="Default branch"
          autoComplete="off"
        />
      </div>
    </div>
  );
}

/** One panel of the form, named only where the fields do not name themselves. */
function FormPanel({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex min-h-0 flex-col gap-4 rounded-lg border p-6">
      {title && (
        <h2 className={typeRole({ role: "section-title" })}>{title}</h2>
      )}
      {children}
    </section>
  );
}
