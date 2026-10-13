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
   * The files belong to a repository: the payload is shown but locked, and
   * the page edits the source that owns it instead.
   */
  isGithubPlugin?: boolean;
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
              readOnly={readOnly}
              locked={isGithubPlugin}
            />
          </SettingsSection>

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
