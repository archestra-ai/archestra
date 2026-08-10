import { SkillFileModel } from "@/models";
import { SKILL_MANIFEST_FILENAME } from "@/skills/parser";
import {
  buildSkillPublicationArtifacts,
  composeSkillManifest,
  parseFrontmatterBlob,
} from "@/skills/skill-manifest-serializer";
import type { PublishableSkill, SkillFile, SkillManifestSource } from "@/types";

/**
 * Resolves what a gateway actually puts on the wire for a skill (SEP-2640):
 * the canonical `SKILL.md` bytes and the digests published beside them.
 *
 * Both live on the skill's own rows — `skills.frontmatter_blob`/`skills.digest`
 * and `skill_files.digest` — written together with the bytes they cover by
 * every model-layer write, so publication reads are pure lookups. A row whose
 * artifacts are missing (it predates migration 0407, or a write outside the
 * model layer tripped the invalidation triggers) is withheld: a skill is
 * served fully verifiable or not at all. The startup backfill
 * (`services/skill-publication-backfill.ts`) repairs such rows.
 */

/** What a gateway needs to publish one skill and verify reads against it. */
export interface SkillPublicationArtifacts {
  /** Canonical serialized frontmatter; composes with the body into SKILL.md. */
  frontmatterBlob: string;
  /**
   * The same frontmatter as an object, for the `skills/list` entry. Parsed
   * back from `frontmatterBlob` rather than rebuilt from the row, so an entry
   * and the manifest it points at can never describe different fields.
   */
  frontmatter: Record<string, unknown>;
  /** `sha256:<hex>` over the composed SKILL.md bytes. */
  digest: string;
  files: Array<{ path: string; digest: string }>;
}

/**
 * Publication artifacts for a batch of skills, keyed by skill id. Skills
 * missing their stored artifacts are absent from the result (withheld).
 *
 * Batched on purpose: a `skills/list` page needs the full file set of every
 * entry it returns, so resolving one skill at a time would make query count
 * scale with page size.
 */
export async function resolveSkillPublicationArtifacts(
  skills: PublishableSkill[],
): Promise<Map<string, SkillPublicationArtifacts>> {
  const result = new Map<string, SkillPublicationArtifacts>();
  if (skills.length === 0) return result;

  const filesBySkill = await SkillFileModel.findPublicationRowsBySkillIds(
    skills.map((s) => s.id),
  );

  for (const skill of skills) {
    const stored = storedArtifacts(skill);
    if (!stored) continue;

    const files: SkillPublicationArtifacts["files"] = [];
    let verifiable = true;
    for (const file of filesBySkill.get(skill.id) ?? []) {
      // A stored top-level SKILL.md is shadowed by the manifest this module
      // composes, so it is never published: listing it would advertise a second
      // digest for a URI that always serves the manifest instead.
      if (file.path === SKILL_MANIFEST_FILENAME) continue;
      if (!file.digest) {
        verifiable = false;
        break;
      }
      files.push({ path: file.path, digest: file.digest });
    }
    // One undigested file withholds the whole skill, not just the file: a
    // partial resource list would advertise a skill whose unlisted files are
    // still readable, which strict hosts treat as a verification failure.
    if (!verifiable) continue;

    result.set(skill.id, {
      frontmatterBlob: stored.frontmatterBlob,
      frontmatter: parseFrontmatterBlob(stored.frontmatterBlob),
      digest: stored.digest,
      files,
    });
  }

  return result;
}

/**
 * The published `SKILL.md` bytes of one skill — the manifest a read returns.
 *
 * Takes a manifest source rather than the resolved skill and its artifacts:
 * both halves of the composition have to come from one read of the row, or the
 * bytes served can be a pairing that never existed (see
 * {@link SkillModel.findManifestSourceById}). The rebuild branch covers an
 * invalidating write landing between resolution and this read — it has the
 * whole row in hand, so composing from the fields is exact.
 */
export function renderSkillManifest(source: SkillManifestSource): string {
  const { frontmatterBlob } =
    storedArtifacts(source) ?? buildSkillPublicationArtifacts(source);
  return composeSkillManifest({ frontmatterBlob, body: source.content });
}

/**
 * One published resource file by its skill-relative path, or null when the
 * skill has no such file.
 *
 * The top-level `SKILL.md` is deliberately not reachable here: that URI always
 * serves the composed manifest, whatever a legacy row may have stored under it.
 */
export async function findPublishedSkillFile(params: {
  skillId: string;
  path: string;
}): Promise<SkillFile | null> {
  if (params.path === SKILL_MANIFEST_FILENAME) return null;
  return await SkillFileModel.findBySkillAndPath(params.skillId, params.path);
}

// ===== Internal =====

/**
 * The row's own publication artifacts, or null when either half is missing.
 * Both halves are written together, so "either missing" means the row predates
 * migration 0407 or an invalidating write reset it.
 */
function storedArtifacts(skill: {
  frontmatterBlob: string | null;
  digest: string | null;
}): { frontmatterBlob: string; digest: string } | null {
  return skill.frontmatterBlob && skill.digest
    ? { frontmatterBlob: skill.frontmatterBlob, digest: skill.digest }
    : null;
}
