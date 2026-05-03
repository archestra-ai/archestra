import { readFileSync, writeFileSync } from "node:fs";

const inputPath = new URL("../costs.utils.bench.json", import.meta.url);
const outputPath = new URL("../costs.utils.bench.md", import.meta.url);
const report = JSON.parse(readFileSync(inputPath, "utf8"));
const benchmarks = report.files[0].groups[0].benchmarks;

const oldBench = benchmarks.find((benchmark) => benchmark.name === "old find transform");
const newBench = benchmarks.find((benchmark) => benchmark.name === "new Map transform");

if (!oldBench || !newBench) {
  throw new Error("Expected both cost chart benchmark cases in JSON report");
}

const speedup = oldBench.mean / newBench.mean;
const markdown = `# Cost Chart Benchmark

Source: \`src/app/llm/(costs)/costs.utils.bench.ts\`

| Case | Mean ms | p75 ms | p99 ms | Hz | Samples | RME |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| old find transform | ${format(oldBench.mean)} | ${format(oldBench.p75)} | ${format(oldBench.p99)} | ${format(oldBench.hz)} | ${oldBench.sampleCount} | ${format(oldBench.rme)}% |
| new Map transform | ${format(newBench.mean)} | ${format(newBench.p75)} | ${format(newBench.p99)} | ${format(newBench.hz)} | ${newBench.sampleCount} | ${format(newBench.rme)}% |

Speedup: **${format(speedup)}x**

Raw JSON: \`costs.utils.bench.json\`
`;

writeFileSync(outputPath, markdown);

function format(value) {
  return Number(value).toFixed(2);
}
