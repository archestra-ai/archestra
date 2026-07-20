/**
 * Current step of a RUNNING content-sync run, one step at a time: a content
 * run first ingests documents, then drains its queued embedding batches —
 * `totalBatches` is only set once the ingest loop finishes, which makes it
 * the phase discriminator. Surfacing the embedding step matters: during a
 * long drain the ingest counters sit frozen at the total, which otherwise
 * reads as a hang. Null for settled runs — they show their outcome instead.
 */
export function contentRunPhase(run: {
  status: string;
  runType?: string | null;
  totalBatches?: number | null;
  completedBatches?: number | null;
  totalItems?: number | null;
  documentsProcessed?: number | null;
}): { label: string; progress: number | null } | null {
  if (run.status !== "running" || run.runType !== "content") return null;
  const totalBatches = run.totalBatches ?? 0;
  if (totalBatches > 0) {
    const completed = run.completedBatches ?? 0;
    return {
      label: `Embedding batch ${completed.toLocaleString()}/${totalBatches.toLocaleString()}`,
      progress: Math.min(100, Math.round((completed / totalBatches) * 100)),
    };
  }
  const total = run.totalItems ?? 0;
  const processed = run.documentsProcessed ?? 0;
  // No total (the upstream count estimate failed or hasn't landed yet): the
  // live processed counter must still show, or a long ingest reads as stuck.
  const label =
    total > 0
      ? `Ingesting documents ${processed.toLocaleString()}/${total.toLocaleString()}`
      : processed > 0
        ? `Ingesting documents · ${processed.toLocaleString()} processed`
        : "Ingesting documents";
  return {
    label,
    progress:
      total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : null,
  };
}
