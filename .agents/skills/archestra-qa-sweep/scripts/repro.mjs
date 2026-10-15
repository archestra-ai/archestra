// Repro gate: runs each finding's repro.mjs N times, each in a fresh browser context, and writes gate.json.
// Usage: node repro.mjs --run <runDir> [--times 2] [findingDir...]   (default: every finding without gate.json)
//        node repro.mjs --run <runDir> --all                          (re-gate everything)
import fs from "node:fs";
import path from "node:path";
import { gateStatus, loadManifest, parseArgs, readJson, runRepro, writeJson } from "./lib.mjs";

const args = parseArgs();
const manifest = loadManifest(args.run);
const times = Number(args.times ?? 2);
const findingsDir = path.join(manifest.runDir, "findings");

const dirs = args._.length
  ? args._.map((d) => path.resolve(d))
  : fs
      .readdirSync(findingsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(findingsDir, d.name))
      .filter((d) => args.all || !fs.existsSync(path.join(d, "gate.json")));

const summary = {};
for (const dir of dirs) {
  const finding = readJson(path.join(dir, "finding.json"));
  const reproFile = path.join(dir, "repro.mjs");
  let gate;
  if (!fs.existsSync(reproFile)) {
    gate = { status: "no-repro", attempts: [] };
  } else {
    const attempts = [];
    for (let i = 0; i < times; i++) {
      const r = await runRepro(manifest, reproFile, { shotsDir: path.join(dir, "gate-shots"), attempt: i });
      attempts.push({
        reproduced: r.reproduced,
        observed: r.observed,
        error: r.error,
        consoleErrors: r.events.console.length,
        failed: r.events.failed.slice(0, 10),
      });
    }
    gate = { status: gateStatus(attempts), attempts };
  }
  gate.gatedAt = new Date().toISOString();
  writeJson(path.join(dir, "gate.json"), gate);
  summary[finding.id] = gate.status;
  console.log(`${finding.id}: ${gate.status}`);
}
const counts = Object.values(summary).reduce((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {});
console.log(JSON.stringify(counts));
