import type { archestraApiTypes } from "@archestra/shared";
import type { ProfileLabel } from "@/components/agent-labels";
import type { InitialPermissionGrant } from "@/components/initial-resource-permissions";
import { composeManifest } from "@/lib/skills/manifest-compose";
import type { SkillDetail } from "./github-sync-panel";

export interface ResourceFile {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
}

/**
 * A skill as it sits in the editor before a save: the whole SKILL.md manifest
 * plus resource files (the content half), and who can use it (the access half).
 * The create wizard fills the halves on separate steps and the detail page
 * shows them on separate tabs, so the draft is owned by the page and handed
 * down — never by the panes that edit it.
 */
export interface SkillDraft {
  initialGrants?: InitialPermissionGrant[];
  manifest: string;
  files: ResourceFile[];
  /** empty = not restricted (available to agents in every environment). */
  environmentIds: string[];
  /** Key/value labels, edited in the form like any other field. */
  labels: ProfileLabel[];
  /** Emoji or image shown with the name; null = the source glyph. */
  icon: string | null;
}

export interface SkillPreview {
  name: string;
  description: string;
  content: string;
  license: string | null;
  compatibility: string | null;
  allowedTools: string | null;
  agentName: string | null;
  templated: boolean;
  metadata: Record<string, string>;
  files: (ResourceFile & { kind?: "reference" | "script" | "asset" })[];
}

/**
 * What a new skill starts with: a working example to edit from, in the
 * layout the Agent Skills specification gives a skill. SKILL.md with the
 * sections most skills have, one script and one reference file it points at,
 * so the folders a skill can carry are there to see. The name and the
 * description are left for the author: the form asks for both.
 */
const STARTER_SKILL_MANIFEST = `---
name: ""
description: ""
---

# Instructions

Replace this text with what the agent should do, step by step.

## When to use

Say when this skill applies. The agent decides from the description above, so put the words a user would use there too.

## Steps

1. Say what to do first.
2. Run \`scripts/example.sh\` when a step needs a command.
3. Read \`references/example.md\` for details that are too long for this file.

## Example

Show one request and the answer you expect.
`;

const STARTER_SKILL_FILES: ResourceFile[] = [
  {
    path: "references/example.md",
    content: `# Example reference

Put details here that the agent needs only sometimes: a long table, a format, a checklist. SKILL.md stays short and points at this file.

Delete this file if the skill does not need it.
`,
    encoding: "utf8",
  },
  {
    path: "scripts/example.sh",
    content: `#!/bin/sh
# An example script. The agent runs it from the skill's folder when the
# instructions say so. Delete this file if the skill does not need it.
echo "Hello from the skill"
`,
    encoding: "utf8",
  },
];

export function blankSkillDraft(): SkillDraft {
  return {
    manifest: STARTER_SKILL_MANIFEST,
    // Copies: the draft's files are edited in place of these.
    files: STARTER_SKILL_FILES.map((file) => ({ ...file })),
    environmentIds: [],
    labels: [],
    icon: null,
  };
}

function stripFileKinds(files: SkillPreview["files"]): ResourceFile[] {
  return files.map(({ path, content, encoding }) => ({
    path,
    content,
    encoding,
  }));
}

export function skillDraftFromSkill(skill: SkillDetail): SkillDraft {
  return {
    manifest: composeManifest(skill),
    files: stripFileKinds(skill.files),
    environmentIds: skill.environments.map((environment) => environment.id),
    labels: skill.labels ?? [],
    icon: skill.icon ?? null,
  };
}

/** A not-yet-imported skill has content only; access is decided at import. */
export function skillDraftFromPreview(preview: SkillPreview): SkillDraft {
  return {
    ...blankSkillDraft(),
    manifest: composeManifest(preview),
    files: stripFileKinds(preview.files),
  };
}

/** True when the skill is pulled from GitHub on a schedule: its manifest and
 * files are repo-owned and read-only here; environments and labels stay
 * editable. */
export function isSyncedGithubSkill(skill: SkillDetail | null | undefined) {
  return skill?.sourceType === "github" && skill.githubSyncInterval != null;
}

/**
 * The request body for a create or an update, built from the draft.
 *
 * `baseVersion` anchors an update to the head the draft was seeded from —
 * passed in rather than read off `skill`, because the two drift the moment a
 * background refetch lands under an unsaved edit. `files` is a whole-set
 * replacement built from that seed, so without the anchor a save would bury
 * anything written since: an `edit_skill` call, a sync pull, another user. A
 * synced skill is exempt: its save carries no files and the backend rejects
 * any content change, so there is nothing to bury — anchoring it would only
 * let the sync worker's own pulls reject an environment edit.
 */
export function buildSkillSaveBody(
  draft: SkillDraft,
  skill: SkillDetail | null,
  baseVersion?: number,
): archestraApiTypes.UpdateSkillData["body"] {
  const synced = isSyncedGithubSkill(skill);
  return {
    ...(!skill
      ? {
          initialGrants: (draft.initialGrants ?? []).map(
            ({ subject, actions }) => ({
              subject,
              actions,
            }),
          ),
        }
      : {}),
    content: draft.manifest,
    ...(synced ? {} : { files: draft.files }),
    environmentIds: draft.environmentIds,
    labels: draft.labels,
    icon: draft.icon,
    ...(skill && !synced && baseVersion !== undefined ? { baseVersion } : {}),
  };
}

const sameIds = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * What the draft still lacks before it can be saved, as one short sentence
 * for the save button to give as its reason. Null when nothing is missing.
 */
export function skillDraftGap(manifest: {
  hasName: boolean;
  hasDescription: boolean;
}): string | null {
  if (!manifest.hasName) return "Enter a skill name.";
  if (!manifest.hasDescription) return "Enter a description.";
  return null;
}

/** Whether the draft differs from the seed it was built from. */
export function isSkillDraftDirty(draft: SkillDraft, seed: SkillDraft) {
  return (
    JSON.stringify(draft.initialGrants ?? []) !==
      JSON.stringify(seed.initialGrants ?? []) ||
    draft.manifest !== seed.manifest ||
    draft.icon !== seed.icon ||
    !sameIds(draft.environmentIds, seed.environmentIds) ||
    draft.labels.length !== seed.labels.length ||
    draft.labels.some(
      (label, i) =>
        label.key !== seed.labels[i]?.key ||
        label.value !== seed.labels[i]?.value,
    ) ||
    draft.files.length !== seed.files.length ||
    draft.files.some(
      (file, i) =>
        file.path !== seed.files[i]?.path ||
        file.content !== seed.files[i]?.content ||
        file.encoding !== seed.files[i]?.encoding,
    )
  );
}

/**
 * A skill's manifest and files as the entries of its .zip, for the Download
 * button in a skill page's header.
 */
export function skillArchiveFiles(skill: {
  manifest: string;
  files: ResourceFile[];
}): Array<{ path: string; content: string; encoding?: "utf8" | "base64" }> {
  return [
    { path: "SKILL.md", content: skill.manifest },
    ...skill.files.map(({ path, content, encoding }) => ({
      path,
      content,
      encoding,
    })),
  ];
}
