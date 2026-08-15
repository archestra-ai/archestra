import { backfillSkillPublicationArtifacts } from "@/services/skill-publication-backfill";

/**
 * Periodic driver for the skill publication-artifact backfill.
 *
 * The service logs its own outcome and never throws, so the periodic chain
 * always reschedules — which is the point of running it on a tick: a pass that
 * fails leaves rows undigested, and an undigested row is filtered out of the
 * `skills/list` query, so the only signal is a skill silently missing from
 * every client's catalog until the next pass repairs it.
 */
export async function handleSkillPublicationBackfill(): Promise<void> {
  await backfillSkillPublicationArtifacts();
}
