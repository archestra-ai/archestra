import type { Comparison, QueryDelta } from "./compare";
import type { RunArtifact } from "./schema";
import { RETRIEVAL_KS } from "./schema";

/** Plain-text renderers for a run and for a two-run comparison. */

export function renderRun(run: RunArtifact): string {
  const out: string[] = [];
  const { fingerprint, ingest, aggregates } = run;
  out.push(`kb-eval run: ${run.run.name} [${run.status}]`);
  out.push(`organization: ${run.run.organizationId}`);
  out.push(
    `embedding: ${fingerprint.embedding ? `${fingerprint.embedding.provider}/${fingerprint.embedding.model} (${fingerprint.embedding.dimensions}d)` : "disabled"}` +
      ` · corpus ${ingest.documents} docs / ${ingest.chunks} chunks · ${run.queries.length} run / ${run.skippedQueries.length} skipped · limit ${run.run.queryLimit}`,
  );
  out.push(
    `config: ${Object.entries(fingerprint.effectiveConfig)
      .map(([key, value]) => `${key}=${value}`)
      .join(" ")}`,
  );
  out.push("");
  out.push("capabilities:");
  out.push(
    table(
      Object.entries(run.capabilities).map(([name, state]) => [
        name,
        state.status,
        truncate(state.detail, 100),
      ]),
      ["capability", "status", "detail"],
    ),
  );
  out.push("");
  if (run.selection) {
    out.push("selected Knowledge components:");
    out.push(
      table(
        run.selection.componentResults.map((result) => [
          result.component,
          result.mode,
          result.status,
          truncate(result.detail, 100),
        ]),
        ["component", "mode", "status", "detail"],
      ),
    );
    out.push("");
  }
  const singleDoc = singleExpectedEverywhere(run);
  const metricRows: string[][] = [];
  for (const k of RETRIEVAL_KS) {
    metricRows.push([
      `hit@${k}${singleDoc ? " (≡ recall)" : ""}`,
      pct(aggregates[`hit@${k}`]),
    ]);
    if (!singleDoc)
      metricRows.push([`recall@${k}`, pct(aggregates[`recall@${k}`])]);
  }
  metricRows.push(["MRR", num(aggregates.mrr)]);
  metricRows.push(["precision@5", pct(aggregates["precision@5"])]);
  if (aggregates["ndcg@5"] !== undefined) {
    metricRows.push(["nDCG@5", pct(aggregates["ndcg@5"])]);
  }
  if (aggregates["map@5"] !== undefined) {
    metricRows.push(["MAP@5", pct(aggregates["map@5"])]);
  }
  if (aggregates["negativeHitRate@5"] !== undefined) {
    metricRows.push(["negative-hit@5", pct(aggregates["negativeHitRate@5"])]);
  }
  if (aggregates.noAnswerForcedRetrievalRate !== undefined) {
    metricRows.push([
      `no-answer forced retrieval (n=${aggregates.noAnswerQueries})`,
      pct(aggregates.noAnswerForcedRetrievalRate),
    ]);
  }
  for (const k of RETRIEVAL_KS) {
    if (aggregates[`evidence@${k}`] !== undefined) {
      metricRows.push([
        `evidence@${k} (n=${aggregates.queriesWithEvidence})`,
        pct(aggregates[`evidence@${k}`]),
      ]);
    }
  }
  metricRows.push(["mean returned", num(aggregates.meanReturned, 1)]);
  out.push(table(metricRows, ["metric", "value"]));
  if (run.uncertainty && Object.keys(run.uncertainty.metrics).length > 0) {
    out.push("");
    out.push("95% bootstrap intervals (synthetic suite; diagnostic only):");
    out.push(
      table(
        Object.entries(run.uncertainty.metrics).map(([metric, interval]) => [
          metric,
          String(interval.n),
          num(interval.estimate),
          `${num(interval.lower)} – ${num(interval.upper)}`,
        ]),
        ["metric", "n", "estimate", "95% interval"],
      ),
    );
  }
  // Topic tags with one or two queries are noise in a table; keep the rest,
  // largest groups first (the JSON artifact keeps every tag).
  const tags = Object.keys(run.byTag)
    .filter((tag) => run.byTag[tag].queries >= MIN_TAG_QUERIES)
    .sort(
      (a, b) =>
        run.byTag[b].queries - run.byTag[a].queries || a.localeCompare(b),
    );
  if (tags.length > 0) {
    out.push("");
    out.push(
      table(
        tags.map((tag) => [
          tag,
          String(run.byTag[tag].queries),
          pct(run.byTag[tag]["hit@1"]),
          pct(run.byTag[tag]["hit@5"]),
          pct(run.byTag[tag]["hit@10"]),
          num(run.byTag[tag].mrr),
          pct(run.byTag[tag]["evidence@10"]),
        ]),
        ["tag", "n", "hit@1", "hit@5", "hit@10", "MRR", "evid@10"],
      ),
    );
    out.push(
      `(tags with fewer than ${MIN_TAG_QUERIES} queries omitted; all tags are in the JSON artifact)`,
    );
  }
  out.push("");
  out.push(
    table(
      run.queries.map((query) => {
        const ranks = Object.values(query.firstRank).filter(
          (value): value is number => value !== null,
        );
        return [
          query.id,
          query.gateMode === "metric-only"
            ? "metric"
            : query.passed
              ? "pass"
              : "FAIL",
          ranks.length === 0 ? "—" : String(Math.min(...ranks)),
          String(query.returned.length),
          num(query.metrics.reciprocalRank, 2),
          query.metrics.evidence["10"] === null
            ? "-"
            : query.metrics.evidence["10"]
              ? "yes"
              : "no",
          stageSummary(query),
          truncate(query.query, 70),
        ];
      }),
      ["query", "gate", "rank", "ret", "RR", "evid@10", "stages", "text"],
    ),
  );
  if (run.skippedQueries.length > 0) {
    out.push("");
    out.push("skipped scenarios:");
    out.push(
      table(
        run.skippedQueries.map((query) => [
          query.id,
          truncate(query.reasons.join("; "), 120),
        ]),
        ["query", "reason"],
      ),
    );
  }
  out.push("");
  out.push(
    `ingest: ${ingest.textDocuments} text / ${ingest.imageDocuments} image / ${ingest.ocrDocuments} OCR docs · ${ingest.contextualizedChunks} contextualized chunks · ${(ingest.wallMs / 1000).toFixed(1)}s`,
  );
  if (run.cleanup.kept) {
    out.push(
      `fixture kept: knowledgeBase=${run.cleanup.knowledgeBaseId} connector=${run.cleanup.connectorId}`,
    );
  } else {
    out.push(
      `fixture cleanup: ${run.cleanup.completed ? "complete" : "FAILED"}`,
    );
  }
  for (const warning of run.warnings) out.push(`warning: ${warning}`);
  for (const error of run.errors) out.push(`ERROR: ${error}`);
  return out.join("\n");
}

export function renderComparison(
  comparison: Comparison,
  options: { all?: boolean } = {},
): string {
  const out: string[] = [];
  out.push(`kb-eval compare: A=${comparison.a.name}  B=${comparison.b.name}`);
  if (comparison.fingerprintMismatch.length > 0) {
    out.push(
      `WARNING: runs are not directly comparable — differing ${comparison.fingerprintMismatch.join(", ")}`,
    );
  }
  if (comparison.unpaired.onlyA.length + comparison.unpaired.onlyB.length > 0) {
    out.push(
      `WARNING: unpaired queries — only in A: ${comparison.unpaired.onlyA.join(", ") || "none"}; only in B: ${comparison.unpaired.onlyB.join(", ") || "none"}`,
    );
  }
  for (const note of comparison.fingerprintNotes) out.push(`note: ${note}`);
  out.push(
    `components: paired=${comparison.components.paired.join(", ") || "none"}; only A=${comparison.components.onlyA.join(", ") || "none"}; only B=${comparison.components.onlyB.join(", ") || "none"}`,
  );
  for (const result of comparison.componentResults.filter(
    (component) => component.changed,
  )) {
    out.push(
      `component ${result.component}: ${result.a?.status ?? "not recorded"} -> ${result.b?.status ?? "not recorded"}`,
    );
  }
  for (const [label, side] of [
    ["A", comparison.a],
    ["B", comparison.b],
  ] as const) {
    for (const warning of side.warnings)
      out.push(`warning (${label}): ${warning}`);
    for (const error of side.errors) out.push(`ERROR (${label}): ${error}`);
  }
  out.push("");
  if (comparison.configDiff.length === 0) {
    out.push(
      "config: identical effective configuration (A and B differ in nothing the pipeline reads)",
    );
  } else {
    out.push("config differences (effective values):");
    out.push(
      table(
        comparison.configDiff.map((entry) => [entry.key, entry.a, entry.b]),
        ["setting", "A", "B"],
      ),
    );
  }
  out.push("");
  const rows = comparison.queries.filter(
    (delta) => options.all || delta.changed,
  );
  out.push(
    rows.length === 0
      ? "per-query: no query changed on any metric."
      : `per-query (${options.all ? "all" : "changed only"}; ${rows.length}/${comparison.queries.length} rows):`,
  );
  if (rows.length > 0) {
    out.push(
      table(
        rows.map((delta) => [
          delta.id,
          arrow(rank(delta.a.bestRank), rank(delta.b.bestRank)),
          `${delta.b.reciprocalRank - delta.a.reciprocalRank >= 0 ? "+" : ""}${(delta.b.reciprocalRank - delta.a.reciprocalRank).toFixed(2)}`,
          scoreMarginCell(delta),
          evidenceCell(delta, 10),
          arrow(String(delta.a.returned), String(delta.b.returned)),
          movedOn(delta),
          truncate(delta.query, 50),
        ]),
        [
          "query",
          "rank",
          "ΔRR",
          "BM25 margin",
          "evid@10",
          "ret",
          "moved on",
          "text",
        ],
      ),
    );
    out.push(
      "(rank = first chunk of an expected doc; ↑ improved / ↓ regressed on that metric)",
    );
  }
  if (comparison.pairedQueryCount > 0) {
    out.push("");
    out.push("wins / losses / ties (B vs A, paired queries only):");
    out.push(
      table(
        Object.entries(comparison.tallies).map(([name, tally]) => [
          name,
          String(tally.wins),
          String(tally.losses),
          String(tally.ties),
        ]),
        ["metric", "wins", "losses", "ties"],
      ),
    );
  }
  out.push("");
  if (comparison.pairedQueryCount === 0) {
    out.push("aggregates: omitted (no golden query was selected in both runs)");
  } else {
    out.push(
      `${
        comparison.singleExpected
          ? "aggregates (every paired query expects one document, so recall@k ≡ hit@k and is not repeated)"
          : "aggregates"
      } — ${comparison.pairedQueryCount} paired queries only:`,
    );
    out.push(
      table(
        Object.entries(comparison.aggregates)
          .filter(
            ([name]) =>
              !(comparison.singleExpected && name.startsWith("recall@")),
          )
          .map(([name, entry]) => {
            const isRate =
              /^(hit|recall|evidence|precision|ndcg|map|negativeHitRate)@/.test(
                name,
              ) || name === "noAnswerForcedRetrievalRate";
            const fmt = (value: number) =>
              isRate ? pct(value) : num(value, name === "mrr" ? 3 : 1);
            const delta = isRate
              ? `${entry.delta >= 0 ? "+" : ""}${(entry.delta * 100).toFixed(1)} pp`
              : `${entry.delta >= 0 ? "+" : ""}${entry.delta.toFixed(3)}`;
            return [name, fmt(entry.a), fmt(entry.b), delta];
          }),
        ["metric", "A", "B", "Δ"],
      ),
    );
    if (Object.keys(comparison.uncertainty).length > 0) {
      out.push("");
      out.push("paired 95% bootstrap delta intervals:");
      out.push(
        table(
          Object.entries(comparison.uncertainty).map(([metric, interval]) => [
            metric,
            String(interval.n),
            `${interval.estimate >= 0 ? "+" : ""}${(interval.estimate * 100).toFixed(1)} pp`,
            `${(interval.lower * 100).toFixed(1)} – ${(interval.upper * 100).toFixed(1)} pp`,
            pct(interval.probabilityImproved),
          ]),
          ["metric", "n", "delta", "95% interval", "P(improved)"],
        ),
      );
    }
  }
  return out.join("\n");
}

// ===== Internal helpers =====

const MIN_TAG_QUERIES = 3;

const pct = (value: number | undefined): string =>
  value === undefined ? "  n/a" : `${(value * 100).toFixed(1).padStart(5)}%`;

const num = (value: number | undefined, digits = 3): string =>
  value === undefined ? "n/a" : value.toFixed(digits);

const rank = (value: number | null): string =>
  value === null ? "—" : String(value);

const truncate = (text: string, width: number): string =>
  text.length <= width ? text : `${text.slice(0, width - 1)}…`;

function table(rows: string[][], header: string[]): string {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => (row[i] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => (cell ?? "").padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  return [
    line(header),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...rows.map(line),
  ].join("\n");
}

function singleExpectedEverywhere(run: RunArtifact): boolean {
  return run.queries.every((query) => query.expected.length === 1);
}

function stageSummary(query: RunArtifact["queries"][number]): string {
  const parts = [
    query.stages.keywordRanker,
    `expand:${query.stages.expandedQueryCount}`,
    `rerank:${query.stages.reranker.status}`,
  ];
  if (query.stages.contextExpanded) parts.push("context:+");
  if (query.stageFailures.length > 0) {
    parts.push(`stage-fail:${query.stageFailures.length}`);
  }
  return parts.join(" ");
}

function arrow(a: string, b: string): string {
  return a === b ? a : `${a}→${b}`;
}

/** The metrics a row moved on, e.g. `hit@3↑ evid@1↓ returned` — so a "changed" row always shows why. */
function movedOn(delta: QueryDelta): string {
  const parts = Object.entries(delta.direction)
    .filter(([, direction]) => direction !== "same")
    .map(
      ([name, direction]) =>
        `${name.replace("evidence@", "evid@")}${direction === "improved" ? "↑" : "↓"}`,
    );
  if (delta.returnedChanged) parts.push("returned");
  return parts.join(" ");
}

function scoreMarginCell(delta: QueryDelta): string {
  if (delta.a.scoreMargin === null || delta.b.scoreMargin === null) return "-";
  return arrow(delta.a.scoreMargin.toFixed(4), delta.b.scoreMargin.toFixed(4));
}

function evidenceCell(delta: QueryDelta, k: number): string {
  const a = delta.a.evidence[String(k)];
  const b = delta.b.evidence[String(k)];
  if (a === null || a === undefined || b === null || b === undefined)
    return "-";
  return arrow(a ? "yes" : "no", b ? "yes" : "no");
}
