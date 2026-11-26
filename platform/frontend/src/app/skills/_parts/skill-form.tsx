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
  parseManifestFields,
  setManifestFrontmatterField,
} from "@/lib/skills/manifest-compose";
import { SkillAccessFields } from "./skill-access-fields";
import {
  SKILL_WIZARD_EDITOR_CLASS,
  SkillContentEditor,
} from "./skill-content-editor";
import type { SkillDraft } from "./skill-draft";
import { isSkillNameUnpublishable } from "./use-skill-name-problem";

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
  nameProblem?: string | null;
}) {
  // Read back out of the manifest rather than kept beside it, so an edit made
  // in the editor shows up in the fields and vice versa.
  const parsed = useMemo(
    () => parseManifestFields(draft.manifest),
    [draft.manifest],
  );
  // Under the name, where the reader is typing it. An error is the one thing
  // to fix first, so the warning waits for a name that can be saved.
  const nameWarning = !nameProblem && isSkillNameUnpublishable(parsed.name);
  const nameNoticeId = nameProblem
    ? "skill-name-problem"
    : nameWarning
      ? "skill-name-warning"
      : undefined;

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
              placeholder="e.g. release-checklist"
              readOnly={readOnly}
              // Repository-owned content is disabled, not just read-only, so it
              // reads as locked rather than as a field that ignores typing.
              disabled={contentReadOnly}
              required
              aria-invalid={nameProblem ? true : undefined}
              aria-describedby={nameNoticeId}
            />
            {nameProblem && (
              <InlineNotice id="skill-name-problem" variant="error" size="xs">
                <AlertTriangle aria-hidden />
                <span className="font-medium">
                  <TextWithCode text={nameProblem} />
                </span>
              </InlineNotice>
            )}
            {nameWarning && (
              // A warning, not a refusal: the skill can be saved as it is.
              <InlineNotice id="skill-name-warning" size="xs">
                <AlertTriangle aria-hidden />
                <span className="font-medium">
                  This name can&apos;t be published over MCP
                </span>
                <InlineNoticeText>
                  You can keep it: the skill works everywhere else. To publish
                  over MCP, use only lowercase letters, digits and single
                  hyphens, up to 64 characters.
                </InlineNoticeText>
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
        <SkillContentEditor
          manifest={draft.manifest}
          files={draft.files}
          onManifestChange={(manifest) => onChange({ manifest })}
          onFilesChange={onFilesChange}
          readOnly={readOnly || contentReadOnly}
          // The page header offers the skill as a .zip.
          showDownload={false}
          // Said under the name field above, next to what it is about.
          nameNotice={false}
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

/**
 * A sentence whose `backticked` parts are characters to type, set as code:
 * "can't contain a slash `/`" shows the slash itself, not the backticks.
 */
function TextWithCode({ text }: { text: string }) {
  // Every other piece between backticks is code. The offset is the key: the
  // pieces of one sentence never move.
  let offset = 0;
  const parts = text.split("`").map((piece, position) => {
    const part = { key: offset, text: piece, isCode: position % 2 === 1 };
    offset += piece.length + 1;
    return part;
  });
  return (
    <>
      {parts.map((part) =>
        part.isCode ? (
          // The border takes the notice's own text colour: the variant owns
          // the palette.
          <code
            key={part.key}
            className="rounded border border-current/30 px-1 font-mono"
          >
            {part.text}
          </code>
        ) : (
          // An element, not bare text: page translation re-parents bare text
          // nodes, and React then fails to replace them.
          <span key={part.key}>{part.text}</span>
        ),
      )}
    </>
  );
}
