import type {
  archestraApiTypes,
  ResourceVisibilityScope,
} from "@archestra/shared";
import { composeManifest } from "@/lib/skills/manifest-compose";
import type { SkillDetail } from "./github-sync-panel";
import type { ProfileLabel } from "@/components/agent-labels";

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
  manifest: string;
  files: ResourceFile[];
  scope: ResourceVisibilityScope;
  teamIds: string[];
  /** People the skill is shared with by name; only meaningful with `personal`. */
  userIds: string[];
  /** empty = not restricted (available to agents in every environment). */
  environmentIds: string[];
  /** Key/value labels, edited in the form like any other field. */
  labels: ProfileLabel[];
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

const BLANK_SKILL_TEMPLATE = `---
name: ""
description: ""
---

# Insert instructions below
`;

export function blankSkillDraft(): SkillDraft {
  return {
    manifest: BLANK_SKILL_TEMPLATE,
    files: [],
    scope: "personal",
    teamIds: [],
    userIds: [],
    environmentIds: [],
    labels: [],
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
    scope: skill.scope,
    teamIds: skill.teams.map((team) => team.id),
    userIds: skill.users.map((user) => user.id),
    environmentIds: skill.environments.map((environment) => environment.id),
    labels: skill.labels,
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
 * files are repo-owned and read-only here; scope/teams/environments stay
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
 * let the sync worker's own pulls reject a scope edit.
 */
export function buildSkillSaveBody(
  draft: SkillDraft,
  skill: SkillDetail | null,
  baseVersion?: number,
): archestraApiTypes.UpdateSkillData["body"] {
  const synced = isSyncedGithubSkill(skill);
  return {
    content: draft.manifest,
    ...(synced ? {} : { files: draft.files }),
    scope: draft.scope,
    teamIds: draft.scope === "team" ? draft.teamIds : [],
    userIds: draft.scope === "personal" ? draft.userIds : [],
    environmentIds: draft.environmentIds,
    labels: draft.labels,
    ...(skill && !synced && baseVersion !== undefined ? { baseVersion } : {}),
  };
}

const sameIds = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/** Whether the draft differs from the seed it was built from. */
export function isSkillDraftDirty(draft: SkillDraft, seed: SkillDraft) {
  return (
    draft.manifest !== seed.manifest ||
    draft.scope !== seed.scope ||
    !sameIds(draft.teamIds, seed.teamIds) ||
    !sameIds(draft.userIds, seed.userIds) ||
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
