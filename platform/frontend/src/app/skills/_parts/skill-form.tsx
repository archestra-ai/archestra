"use client";

import {
  INVALID_SKILL_DESCRIPTION_LEAD,
  INVALID_SKILL_NAME_LEAD,
  SKILL_DESCRIPTION_RULE,
  SKILL_DESCRIPTION_SPEC_URL,
  SKILL_NAME_RULE,
  SKILL_NAME_SPEC_URL,
} from "@archestra/shared";
import { type Ref, useMemo, useState } from "react";
import type { ProfileLabelsRef } from "@/components/agent-labels";
import { IdentityFields } from "@/components/identity-fields";
import {
  SettingsSection,
  SettingsSectionGroup,
} from "@/components/settings-section";
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
  descriptionProblem = null,
  manifestProblem = null,
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
  /** Why the typed description cannot be saved; shown under the field. */
  descriptionProblem?: string | null;
  /** The line of SKILL.md a save was refused for; marked in the editor. */
  manifestProblem?: { line: number; message: string } | null;
}) {
  // Read back out of the manifest rather than kept beside it, so an edit made
  // in the editor shows up in the fields and vice versa.
  const parsed = useMemo(
    () => parseManifestFields(draft.manifest),
    [draft.manifest],
  );
  // Both fields are required. A field left empty says so once the reader has
  // been in it and moved on, not while the form is still untouched.
  const namesEditable = !readOnly && !contentReadOnly;
  const [visited, setVisited] = useState({ name: false, description: false });
  const nameMissing = namesEditable && visited.name && !parsed.hasName;
  const descriptionMissing =
    namesEditable && visited.description && !parsed.hasDescription;
  const nameInvalid = nameProblem !== null || nameMissing;
  const descriptionInvalid = descriptionProblem !== null || descriptionMissing;

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
            label={
              <FieldLabel htmlFor="skill-name" required={namesEditable}>
                Skill name
              </FieldLabel>
            }
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
              onBlur={() => setVisited((fields) => ({ ...fields, name: true }))}
              aria-invalid={nameInvalid ? true : undefined}
              aria-describedby={nameInvalid ? "skill-name-problem" : undefined}
            />
            {nameInvalid && (
              <FieldProblem id="skill-name-problem">
                {nameProblem?.kind === "invalid" ? (
                  <RuleRefusal
                    lead={INVALID_SKILL_NAME_LEAD}
                    rule={SKILL_NAME_RULE}
                    href={SKILL_NAME_SPEC_URL}
                  />
                ) : (
                  <span>{nameProblem?.message ?? "Enter a skill name."}</span>
                )}
              </FieldProblem>
            )}
          </IdentityFields>
          <div className="space-y-2">
            <FieldLabel htmlFor="skill-description" required={namesEditable}>
              Description
            </FieldLabel>
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
              onBlur={() =>
                setVisited((fields) => ({ ...fields, description: true }))
              }
              aria-invalid={descriptionInvalid ? true : undefined}
              aria-describedby={
                descriptionInvalid ? "skill-description-problem" : undefined
              }
            />
            {descriptionInvalid && (
              <FieldProblem id="skill-description-problem">
                {descriptionProblem ? (
                  <RuleRefusal
                    lead={INVALID_SKILL_DESCRIPTION_LEAD}
                    rule={SKILL_DESCRIPTION_RULE}
                    href={SKILL_DESCRIPTION_SPEC_URL}
                  />
                ) : (
                  <span>Enter a description.</span>
                )}
              </FieldProblem>
            )}
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
          manifestProblem={manifestProblem}
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
 * A field's label, with the mark the app's forms give a required field. The
 * mark sits beside the label, not inside it, so the label's text stays the
 * field's name.
 */
function FieldLabel({
  htmlFor,
  required,
  children,
}: {
  htmlFor: string;
  required: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1">
      <Label htmlFor={htmlFor}>{children}</Label>
      {required && (
        // The label's own colour: the mark says "required", not "wrong".
        <span className="text-sm font-medium leading-none" aria-hidden="true">
          *
        </span>
      )}
    </div>
  );
}

/**
 * Why a field's value cannot be saved, under the field: one line of small
 * red text, as the app's other forms write a field's error. The field's own
 * red outline already marks it, so a boxed notice here would be a second
 * red frame for the same thing.
 */
function FieldProblem({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  return (
    <p id={id} className="text-xs text-destructive">
      {children}
    </p>
  );
}

/**
 * A value refused by a rule of the Agent Skills specification: what is wrong,
 * then the rule itself as a link to where the specification states it. The
 * words are the ones the API sends (`describeUnusableSkillName`,
 * `describeUnusableSkillDescription`).
 */
function RuleRefusal({
  lead,
  rule,
  href,
}: {
  lead: string;
  rule: string;
  href: string;
}) {
  return (
    <>
      <span>{lead}</span>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-4"
      >
        {rule}
      </a>
      <span>.</span>
    </>
  );
}
