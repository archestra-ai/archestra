"use client";

import type { Ref } from "react";
import { AdvancedSection } from "@/components/advanced-section";
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
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PluginContentFields } from "./plugin-content-fields";
import type { PluginDraft } from "./plugin-draft";

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
  pluginId,
  activeSection,
  nameTaken = null,
}: {
  draft: PluginDraft;
  onChange: (patch: Partial<PluginDraft>) => void;
  labelsRef?: Ref<ProfileLabelsRef>;
  /** The plugin is not this reader's to change. */
  readOnly?: boolean;
  /** The immutable identity a saved plugin keeps across renames. */
  pluginSlug?: string;
  /**
   * The files belong to a repository: the payload is shown but locked, and
   * the page edits the source that owns it instead.
   */
  isGithubPlugin?: boolean;
  /**
   * The saved plugin whose access policy this form edits.
   *
   * Access is a grant now. A saved plugin answers "who can reach this" from
   * its own policy, so the form shows that policy rather than the retired
   * visibility fields, which nothing reads once the plugin has converted.
   */
  pluginId?: string;
  activeSection: "general" | "permissions";
  /** Whose visible plugin for the same client carries this name, if any. */
  nameTaken?: "own" | "other" | null;
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
              icon={draft.icon}
              onIconChange={(icon) => onChange({ icon })}
              description={draft.description}
              onDescriptionChange={(description) => onChange({ description })}
              // A Git plugin's client is the one its repository was imported
              // for; any other plugin's can be changed, as its platforms can.
              clientType={isGithubPlugin ? undefined : draft.clientType}
              onClientTypeChange={
                isGithubPlugin
                  ? undefined
                  : (clientType) => onChange({ clientType })
              }
              pluginSlug={pluginSlug}
              platforms={draft.supportedPlatforms}
              onPlatformsChange={(supportedPlatforms) =>
                onChange({ supportedPlatforms })
              }
              files={draft.files}
              onFilesChange={(files) => onChange({ files })}
              readOnly={readOnly}
              locked={isGithubPlugin}
              nameTaken={nameTaken}
            />
          </SettingsSection>

          {/* Create has nothing to turn off yet: a new plugin starts
              available, and the switch appears once it is saved. */}
          {pluginId !== undefined && (
            <SettingsSection>
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-2">
                  <Label htmlFor="plugin-enabled">Available to install</Label>
                  <FieldDescription id="plugin-enabled-description">
                    When off, nobody can install this plugin. Copies that are
                    already installed stay on developer machines.
                  </FieldDescription>
                </div>
                <Switch
                  id="plugin-enabled"
                  checked={draft.enabled}
                  onCheckedChange={(enabled) => onChange({ enabled })}
                  disabled={readOnly}
                  aria-describedby="plugin-enabled-description"
                />
              </div>
            </SettingsSection>
          )}

          <SettingsSection>
            <fieldset disabled={readOnly}>
              {/* Labels only organize the list, so they wait under Advanced unless set. */}
              <AdvancedSection
                defaultOpen={draft.labels.length > 0}
                className="border-t-0 pt-0"
              >
                <ProfileLabels
                  ref={labelsRef}
                  labels={draft.labels}
                  onLabelsChange={(labels) => onChange({ labels })}
                />
              </AdvancedSection>
            </fieldset>
          </SettingsSection>
        </SettingsSectionGroup>
      ) : (
        <ResourceAccessSection
          resource="plugin"
          id={pluginId}
          grants={draft.initialGrants}
          onGrantsChange={(initialGrants) => onChange({ initialGrants })}
          standalone
        />
      )}
    </>
  );
}
