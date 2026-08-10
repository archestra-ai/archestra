import logger from "@/logging";
import { SkillFileModel, SkillModel } from "@/models";
import {
  buildSkillPublicationArtifacts,
  computeFileDigest,
} from "@/skills/skill-manifest-serializer";

/**
 * Digests every skill and skill file written before migration 0407 added the
 * publication-artifact columns, so the gateway (which withholds undigested
 * rows rather than serving them unverifiable) can publish the whole catalog.
 *
 * App-side on purpose: the application is the single digest authority
 * (`skill-manifest-serializer.ts`), and a SQL backfill would decode base64 with
 * Postgres semantics, which disagree with Node's on non-canonical input.
 * Idempotent — both writers are `IS NULL` guarded — so concurrent pods and
 * repeated passes are safe.
 *
 * Driven by the `skill_publication_backfill` periodic task rather than a boot
 * hook: an undigested row is filtered out of the listing query, so a failed
 * pass shows up as skills silently missing from every client's catalog. A tick
 * bounds how long that lasts to one interval instead of until someone restarts
 * the worker. O(1) no-op once the catalog is fully digested.
 */
export async function backfillSkillPublicationArtifacts(): Promise<void> {
  try {
    const skills = await backfillSkillArtifacts();
    const files = await backfillFileDigests();
    if (skills > 0 || files > 0) {
      logger.info(
        { skills, files },
        "Backfilled skill publication artifacts for rows predating migration 0407",
      );
    }
  } catch (error) {
    // Counted rather than described: rows left undigested are withheld from
    // `skills/list` by the same predicate that keeps the page from coming back
    // empty, so without a number here the only symptom is a catalog that looks
    // legitimately empty.
    const [skills, files] = await Promise.all([
      SkillModel.countRowsMissingPublicationArtifacts().catch(() => -1),
      SkillFileModel.countRowsMissingDigest().catch(() => -1),
    ]);
    logger.error(
      { err: error, skillsWithheld: skills, filesWithheld: files },
      "Skill publication backfill failed; the rows it did not digest stay unpublished until the next tick retries it",
    );
  }
}

// ===== Internal =====

/** Rows read per keyset page, before the byte budget subdivides them. */
const PAGE_SIZE = 100;

/**
 * Characters of `content` loaded at once. A single skill file runs to
 * ~14M chars (`MAX_SKILL_FILE_CONTENT_CHARS` — a 10MB binary asset after
 * base64 expansion), so a page of 100 would be gigabytes of JS string on a
 * worker that is usually memory-capped. Sizes are read first and the page is
 * then cut to fit this budget; a single row larger than it travels alone.
 */
const MAX_BATCH_CHARS = 16_000_000;

async function backfillSkillArtifacts(): Promise<number> {
  let total = 0;
  let afterId: string | undefined;
  for (;;) {
    const sizes = await SkillModel.findRowSizesMissingPublicationArtifacts({
      afterId,
      limit: PAGE_SIZE,
    });
    if (sizes.length === 0) return total;
    // Keyset resume rather than re-reading from the start: the fill is
    // IS NULL-guarded, so a row a concurrent edit refreshed first would
    // otherwise be re-read forever.
    afterId = sizes[sizes.length - 1].id;

    for (const ids of budgetedChunks(sizes)) {
      const rows = await SkillModel.findManifestSourcesMissingArtifacts(ids);
      if (rows.length === 0) continue;

      await SkillModel.fillPublicationArtifacts(
        rows.map((row) => ({
          id: row.id,
          ...buildSkillPublicationArtifacts(row),
        })),
      );
      total += rows.length;
    }
  }
}

async function backfillFileDigests(): Promise<number> {
  let total = 0;
  let afterId: string | undefined;
  for (;;) {
    const sizes = await SkillFileModel.findRowSizesMissingDigest({
      afterId,
      limit: PAGE_SIZE,
    });
    if (sizes.length === 0) return total;
    afterId = sizes[sizes.length - 1].id;

    for (const ids of budgetedChunks(sizes)) {
      const rows = await SkillFileModel.findDigestSourcesByIds(ids);
      if (rows.length === 0) continue;

      await SkillFileModel.fillDigests(
        rows.map((row) => ({ id: row.id, digest: computeFileDigest(row) })),
      );
      total += rows.length;
    }
  }
}

/**
 * Cut a sized page into id chunks that fit {@link MAX_BATCH_CHARS}. A row
 * whose own size exceeds the budget is yielded alone rather than skipped —
 * refusing to digest it would withhold its skill forever.
 */
function* budgetedChunks(
  rows: Array<{ id: string; chars: number }>,
): Generator<string[]> {
  let chunk: string[] = [];
  let chars = 0;

  for (const row of rows) {
    if (chunk.length > 0 && chars + row.chars > MAX_BATCH_CHARS) {
      yield chunk;
      chunk = [];
      chars = 0;
    }
    chunk.push(row.id);
    chars += row.chars;
  }

  if (chunk.length > 0) yield chunk;
}
