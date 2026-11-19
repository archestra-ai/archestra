import client from "prom-client";

let generationsTotal: client.Counter<string>;
let coverageRatio: client.Gauge<string>;
let initialized = false;

export function initializeToolSearchTextMetrics(): void {
  if (initialized) return;
  initialized = true;

  generationsTotal = new client.Counter({
    name: "tool_search_text_generations_total",
    help: "Tool search text generation attempts by outcome",
    labelNames: ["outcome"],
  });
  coverageRatio = new client.Gauge({
    name: "tool_search_text_coverage_ratio",
    help: "Share of catalog tool definitions with generated search text",
  });
}

export function reportGeneration(outcome: "ready" | "empty" | "failed"): void {
  generationsTotal?.inc({ outcome });
}

export function reportCoverage(ratio: number): void {
  coverageRatio?.set(ratio);
}
