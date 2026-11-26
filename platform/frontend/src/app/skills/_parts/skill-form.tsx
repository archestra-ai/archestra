"use client";

import { AlertTriangle } from "lucide-react";
import { type Ref, useMemo } from "react";
import type { ProfileLabelsRef } from "@/components/agent-labels";
import { IdentityFields } from "@/components/identity-fields";
import {
  SettingsSection,
  SettingsSectionGroup,
} from "@/components/settings-section";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  findFrontmatterNotKept,
  parseManifestFields,
  setManifestFrontmatterField,
} from "@/lib/skills/manifest-compose";
import { SkillAccessFields } from "./skill-access-fields";
import {
  SKILL_WIZARD_EDITOR_CLASS,
  SkillContentEditor,
} from "./skill-content-editor";
import type { SkillDraft } from "./skill-draft";
import type { SkillNameProblem } from "./use-skill-name-problem";

/**
 * Everything a skill is, on one page: what it is called and does, the
 * SKILL.md manifest and its resource files, and — at the end — who can use it
 * and how it is labelled.
 *
 * One component so a skill is filled in the same order and the same shape
 * wherever it is filled in: the create wizard's blank template and the skill's
 * own page render this, differing only in the footer underneath and in what
 * a GitHub-sourced skill locks.
 */
export function SkillForm({
  draft,
  creating = false,
  onChange,
  onFilesChange,
  labelsRef,
  readOnly = false,
  contentReadOnly = false,
  nameProblem = null,
}: {
  draft: SkillDraft;
  creating?: boolean;
  onChange: (patch: Partial<SkillDraft>) => void;
  onFilesChange: (
    update: (files: SkillDraft["files"]) => SkillDraft["files"],
  ) => void;
  labelsRef?: Ref<ProfileLabelsRef>;
  /** The whole skill is not this reader's to change. */
  readOnly?: boolean;
  /**
   * The manifest and files alone are locked while access stays editable —
   * a GitHub-synced skill, whose content is owned by the repository.
   */
  contentReadOnly?: boolean;
  /** Why the typed name cannot be saved; shown under the field. */
  nameProblem?: SkillNameProblem | null;
}) {
  // Read back out of the manifest rather than kept beside it, so an edit made
  // in the editor shows up in the fields and vice versa.
  const parsed = useMemo(
    () => parseManifestFields(draft.manifest),
    [draft.manifest],
  );

  // What the save would drop, said while the author can still move it: a
  // repository-owned or read-only manifest is not this reader's to change.
  const notKept = useMemo(
    () =>
      readOnly || contentReadOnly
        ? null
        : findFrontmatterNotKept(draft.manifest),
    [draft.manifest, readOnly, contentReadOnly],
  );

  return (
    <SettingsSectionGroup>
      {/* No heading: the page header already names the skill, and the fields
          — Skill name, Description, the manifest — say what they are. */}
      <SettingsSection>
        {/* Name and description are frontmatter keys, written straight back
            into the manifest below rather than held beside it: the editor
            stays the source of truth, so the two never disagree. */}
        <div className="space-y-4">
          {/* The icon is Archestra's, not the repository's: it stays
              editable while the name is locked to the source. */}
          <IdentityFields
            icon={draft.icon}
            onIconChange={(icon) => onChange({ icon })}
            fallbackType="skill"
            disabled={readOnly}
            label={<Label htmlFor="skill-name">Skill name</Label>}
          >
            <Input
              id="skill-name"
              value={parsed.name ?? ""}
              onChange={(event) =>
                onChange({
                  manifest: setManifestFrontmatterField({
                    manifest: draft.manifest,
                    field: "name",
                    value: event.target.value,
                  }),
                })
              }
              placeholder="release-checklist"
              readOnly={readOnly}
              // Repository-owned content is disabled, not just read-only, so it
              // reads as locked rather than as a field that ignores typing.
              disabled={contentReadOnly}
              required
              aria-invalid={nameProblem ? true : undefined}
              aria-describedby={nameProblem ? "skill-name-problem" : undefined}
            />
            {nameProblem && (
              <InlineNotice id="skill-name-problem" variant="error" size="xs">
                <AlertTriangle aria-hidden />
                <span className="font-medium">{nameProblem.title}</span>
                <InlineNoticeText>{nameProblem.detail}</InlineNoticeText>
              </InlineNotice>
            )}
          </IdentityFields>
          <div className="space-y-2">
            <Label htmlFor="skill-description">Description</Label>
            <Textarea
              id="skill-description"
              value={parsed.description ?? ""}
              onChange={(event) =>
                onChange({
                  manifest: setManifestFrontmatterField({
                    manifest: draft.manifest,
                    field: "description",
                    value: event.target.value,
                  }),
                })
              }
              placeholder="What this skill teaches agents to do"
              rows={2}
              readOnly={readOnly}
              // Repository-owned content is disabled, not just read-only, so it
              // reads as locked rather than as a field that ignores typing.
              disabled={contentReadOnly}
              required
            />
          </div>
        </div>
        {notKept &&
          (notKept.keys.length > 0 ||
            notKept.nestedMetadataKeys.length > 0) && (
            <InlineNotice id="skill-frontmatter-not-kept">
              <AlertTriangle aria-hidden />
              <span className="font-medium">
                Some frontmatter will not be saved
              </span>
              <InlineNoticeText>
                {notKept.keys.length > 0 && (
                  <span>
                    {`Only name, description, license, compatibility, allowed-tools, agent, templated and metadata are kept. Saving removes: ${notKept.keys.join(", ")}. `}
                  </span>
                )}
                {notKept.nestedMetadataKeys.length > 0 && (
                  <span>
                    {`Metadata values are saved as text, so these nested values become one line of JSON: ${notKept.nestedMetadataKeys.join(", ")}.`}
                  </span>
                )}
              </InlineNoticeText>
            </InlineNotice>
          )}
        <SkillContentEditor
          manifest={draft.manifest}
          files={draft.files}
          onManifestChange={(manifest) => onChange({ manifest })}
          onFilesChange={onFilesChange}
          readOnly={readOnly || contentReadOnly}
          className={SKILL_WIZARD_EDITOR_CLASS}
        />
      </SettingsSection>

      {/* No heading: the visibility control names the section itself. */}
      <SettingsSection>
        <fieldset disabled={readOnly} className="contents">
          <SkillAccessFields
            creating={creating}
            ref={labelsRef}
            draft={draft}
            onChange={onChange}
          />
        </fieldset>
      </SettingsSection>
    </SettingsSectionGroup>
  );
}
