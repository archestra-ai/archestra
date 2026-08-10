import { createHash } from "node:crypto";
import { dump as dumpYaml, load as parseYaml } from "js-yaml";
import type { SkillFileEncoding } from "@/types/skill";

/**
 * Serializes a stored skill back into canonical `SKILL.md` bytes — the inverse
 * of `parser.ts::parseSkillManifest`, which splits frontmatter into columns and
 * keeps only the stripped body.
 *
 * The output is the artifact published over MCP (SEP-2640), so it must be
 * *byte-stable*: the same skill state must always produce the same bytes, or
 * the digest changes and hosts treat an already-approved skill as tampered
 * with. Determinism is bought twice over — a fixed field order plus pinned YAML
 * options here, and persistence of the serialized frontmatter on
 * `skills.frontmatter_blob`, so the read path composes stored bytes rather than
 * re-serializing. A change to this module (or to js-yaml) can therefore only
 * affect a skill on its *next* write; it can never retroactively churn what a
 * host already approved.
 *
 * Only standard agentskills.io frontmatter fields are emitted, verbatim,
 * including the experimental `allowed-tools`. Archestra-internal fields
 * (`templated`, `agentName`) are deliberately never written — the skill types
 * that use them are not published over MCP at all.
 *
 * @see https://agentskills.io/specification
 */

/** The stored skill fields that make up published `SKILL.md` frontmatter. */
interface SerializableSkill {
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  allowedTools: string | null;
  metadata: Record<string, string>;
}

/**
 * The published frontmatter as an object, read back from the stored blob.
 *
 * SEP-2640 requires the `frontmatter` carried in a `skills/list` entry to match
 * the served `SKILL.md` field-by-field, so hosts can verify one against the
 * other. Both therefore derive from the same persisted bytes: re-serializing
 * the row instead would make the entry track this module while the manifest
 * (and the digest covering it) tracked the blob, and the two would disagree for
 * every skill not rewritten since the change.
 *
 * A blob that does not parse to a mapping yields `{}` rather than throwing —
 * the manifest bytes are still served and still match their digest, so a
 * listing degrades to an empty frontmatter rather than failing the whole page.
 */
export function parseFrontmatterBlob(blob: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseYaml(blob);
  } catch {
    return {};
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/**
 * Assemble canonical `SKILL.md` bytes from a stored frontmatter blob and the
 * skill body — the exact bytes a `resources/read` of the manifest returns and
 * `skills.digest` is taken over.
 *
 * Both halves come from the `skills` row, and every write that changes either
 * recomputes the digest, so the served bytes and the published digest cannot
 * disagree.
 */
export function composeSkillManifest(params: {
  frontmatterBlob: string;
  body: string;
}): string {
  // `dump` always terminates with a newline, so the closing fence needs none.
  const frontmatter = params.frontmatterBlob.endsWith("\n")
    ? params.frontmatterBlob
    : `${params.frontmatterBlob}\n`;
  const body = params.body.trim();
  return body.length > 0
    ? `---\n${frontmatter}---\n\n${body}\n`
    : `---\n${frontmatter}---\n`;
}

/**
 * Everything a skill needs to be published: the canonical frontmatter bytes and
 * the digest of the `SKILL.md` those bytes compose with the body.
 *
 * The pair is derived from the skill's own columns and stored on the row
 * (`frontmatter_blob`, `digest`), rewritten by every write that touches either
 * half — so what a gateway serves and the digest it advertises are always
 * written together. Reads only call this for rows that predate the columns.
 */
export function buildSkillPublicationArtifacts(skill: {
  name: string;
  description: string;
  license?: string | null;
  compatibility?: string | null;
  allowedTools?: string | null;
  metadata?: Record<string, string> | null;
  content: string;
}): { frontmatterBlob: string; digest: string } {
  const frontmatterBlob = serializeSkillFrontmatter({
    name: skill.name,
    description: skill.description,
    license: skill.license ?? null,
    compatibility: skill.compatibility ?? null,
    allowedTools: skill.allowedTools ?? null,
    metadata: skill.metadata ?? {},
  });
  return {
    frontmatterBlob,
    digest: computeManifestDigest(
      composeSkillManifest({ frontmatterBlob, body: skill.content }),
    ),
  };
}

/**
 * `sha256:<hex>` over a stored file's *raw* bytes. Base64-encoded binary assets
 * are decoded first, so the digest covers what a client actually receives
 * rather than its storage encoding.
 */
export function computeFileDigest(params: {
  content: string;
  encoding: SkillFileEncoding;
}): string {
  return formatDigest(
    Buffer.from(
      params.content,
      params.encoding === "base64" ? "base64" : "utf8",
    ),
  );
}

// ===== Internal =====

/** `sha256:<64 lowercase hex>` over UTF-8 bytes — the SEP-2640 digest format. */
function computeManifestDigest(manifest: string): string {
  return formatDigest(Buffer.from(manifest, "utf8"));
}

/**
 * The canonical YAML frontmatter of a skill — what `skills.frontmatter_blob`
 * stores, without the `---` fences the manifest wraps it in.
 */
function serializeSkillFrontmatter(skill: SerializableSkill): string {
  return dumpYaml(buildFrontmatterObject(skill), YAML_DUMP_OPTIONS);
}

/**
 * The frontmatter of a skill being *written*, as a JSON object, in canonical
 * order — the source `frontmatter_blob` is serialized from.
 *
 * Write-side only, and deliberately not exported: readers go through
 * {@link parseFrontmatterBlob}. This function reflects the current code, while
 * the blob holds the bytes a skill was last written with, and the two diverge
 * the moment this module changes.
 */
function buildFrontmatterObject(
  skill: SerializableSkill,
): Record<string, unknown> {
  const frontmatter: Record<string, unknown> = {
    name: skill.name,
    description: skill.description,
  };

  // Optional fields are omitted rather than emitted null, so an absent value
  // and an empty one serialize identically.
  if (skill.license) frontmatter.license = skill.license;
  if (skill.compatibility) frontmatter.compatibility = skill.compatibility;
  if (skill.allowedTools) frontmatter["allowed-tools"] = skill.allowedTools;
  if (Object.keys(skill.metadata).length > 0) {
    // Metadata keys are author-supplied and carry no meaningful order, so sort
    // them: two writes of the same map must not differ by insertion order.
    frontmatter.metadata = Object.fromEntries(
      Object.entries(skill.metadata).sort(([a], [b]) => (a < b ? -1 : 1)),
    );
  }

  return frontmatter;
}

/**
 * Pinned for byte-stability. `lineWidth: -1` disables the width-based line
 * folding that would otherwise let a long description wrap differently as text
 * changes; `sortKeys: false` preserves the explicit field order built above;
 * `noRefs` keeps repeated values inline instead of emitting YAML anchors;
 * `quotingType`/`forceQuotes` fix one quoting style so a string's rendering
 * never depends on js-yaml's heuristics.
 */
const YAML_DUMP_OPTIONS = {
  lineWidth: -1,
  sortKeys: false,
  noRefs: true,
  quotingType: '"',
  forceQuotes: false,
} as const;

function formatDigest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
