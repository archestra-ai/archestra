import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const dashboardPath = path.join(
  process.cwd(),
  "dev/grafana/dashboards/rag-knowledge-base.json",
);
const dashboard = JSON.parse(fs.readFileSync(dashboardPath, "utf8"));

test("knowledge base dashboard uses time-range aware stat queries", () => {
  const panelsById = new Map(dashboard.panels.map((panel) => [panel.id, panel]));

  assert.equal(
    dashboard.title,
    "Archestra / Knowledge Base Operations",
  );
  assert.equal(
    dashboard.description,
    "Knowledge base operations monitoring: connector syncs, ingestion, embeddings, query volume, and reranker performance",
  );

  assert.equal(
    panelsById.get(4).targets[0].expr,
    'sum(increase(rag_connector_syncs_total{connector_type=~"$connector_type"}[$__range])) or vector(0)',
  );
  assert.equal(
    panelsById.get(5).targets[0].expr,
    '100 * sum(increase(rag_connector_syncs_total{connector_type=~"$connector_type", status="success"}[$__range])) / clamp_min(sum(increase(rag_connector_syncs_total{connector_type=~"$connector_type"}[$__range])), 1)',
  );
  assert.equal(
    panelsById.get(6).targets[0].expr,
    'sum(increase(rag_documents_ingested_total{connector_type=~"$connector_type"}[$__range])) or vector(0)',
  );
  assert.equal(
    panelsById.get(7).targets[0].expr,
    'sum(increase(rag_chunks_created_total{connector_type=~"$connector_type"}[$__range])) or vector(0)',
  );
  assert.equal(
    panelsById.get(11).targets[0].expr,
    "sum(increase(rag_embedding_batches_total[$__range])) or vector(0)",
  );
  assert.equal(
    panelsById.get(12).targets[0].expr,
    '100 * sum(increase(rag_embedding_batches_total{status="error"}[$__range])) / clamp_min(sum(increase(rag_embedding_batches_total[$__range])), 1)',
  );
  assert.equal(
    panelsById.get(18).targets[0].expr,
    'sum(increase(rag_queries_total{search_type=~"$search_type"}[$__range])) or vector(0)',
  );
});

test("knowledge base reranker token panel includes explicit zero-safe series", () => {
  const rerankerTokenPanel = dashboard.panels.find((panel) => panel.id === 23);

  assert.deepEqual(
    rerankerTokenPanel.targets.map((target) => ({
      expr: target.expr,
      legendFormat: target.legendFormat,
      refId: target.refId,
    })),
    [
      {
        expr: 'sum(rate(llm_tokens_total{source="knowledge:reranker", type="input"}[$__rate_interval])) or vector(0)',
        legendFormat: "input",
        refId: "A",
      },
      {
        expr: 'sum(rate(llm_tokens_total{source="knowledge:reranker", type="output"}[$__rate_interval])) or vector(0)',
        legendFormat: "output",
        refId: "B",
      },
    ],
  );
});
