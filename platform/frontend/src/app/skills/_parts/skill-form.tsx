"use client";

import { type ReactNode, type Ref, useMemo } from "react";
import type { ProfileLabelsRef } from "@/components/agent-labels";
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
  onChange,
  onFilesChange,
  labelsRef,
  readOnly = false,
  contentReadOnly = false,
  contentNotice,
}: {
  draft: SkillDraft;
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
  /** Where a GitHub skill says where its content comes from. */
  contentNotice?: ReactNode;
}) {
  // Read back out of the manifest rather than kept beside it, so an edit made
  // in the editor shows up in the fields and vice versa.
  const parsed = useMemo(
    () => parseManifestFields(draft.manifest),
    [draft.manifest],
  );

  return (
    <div className="flex flex-col gap-4">
      {/* No heading: the page header already names the skill, and the fields
          — Skill name, Description, the manifest — say what they are. */}
      <FormPanel>
        {/* Name and description are frontmatter keys, written straight back
            into the manifest below rather than held beside it: the editor
            stays the source of truth, so the two never disagree. */}
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="skill-name">Skill name</Label>
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
              readOnly={readOnly || contentReadOnly}
              required
            />
          </div>
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
              readOnly={readOnly || contentReadOnly}
              required
            />
          </div>
        </div>
        {contentNotice}
        <SkillContentEditor
          manifest={draft.manifest}
          files={draft.files}
          onManifestChange={(manifest) => onChange({ manifest })}
          onFilesChange={onFilesChange}
          readOnly={readOnly || contentReadOnly}
          className={SKILL_WIZARD_EDITOR_CLASS}
        />
      </FormPanel>

      {/* No heading: the visibility control names the section itself. */}
      <FormPanel>
        <fieldset disabled={readOnly} className="contents">
          <SkillAccessFields
            ref={labelsRef}
            draft={draft}
            onChange={onChange}
          />
        </fieldset>
      </FormPanel>
    </div>
  );
}

/** One panel of the form. Every panel's own fields name it, so none is titled. */
function FormPanel({ children }: { children: ReactNode }) {
  return (
    <section className="flex min-h-0 flex-col gap-4 rounded-lg border p-6">
      {children}
    </section>
  );
}
