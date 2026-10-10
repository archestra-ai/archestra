// Cross-run baseline of triaged findings, kept outside the repo (default ~/.archestra-qa/known).
//   import: node known.mjs import --run <runDir> --decisions <triage-decisions.json>
//   replay: node known.mjs replay --run <runDir>   → <run>/regressions.json
//   list:   node known.mjs list
// Decisions: fix | later keep their repro as a regression check; wont | nab suppress the fingerprint in reports.
import fs from "node:fs";
import path from "node:path";
import { gateStatus, KNOWN_DIR, loadKnown, loadManifest, parseArgs, readJson, runRepro, writeJson } from "./lib.mjs";

async function importDecisions(args) {
  const manifest = loadManifest(args.run);
  const decisions = readJson(args.decisions);
  let n = 0;
  for (const d of decisions) {
    if (!d.status || !d.fingerprint) continue;
    const src = path.join(manifest.runDir, "findings", d.id);
    const dst = path.join(KNOWN_DIR, d.fingerprint);
    fs.mkdirSync(dst, { recursive: true });
    const prev = readJson(path.join(dst, "entry.json"), {});
    if (fs.existsSync(path.join(src, "repro.mjs"))) fs.copyFileSync(path.join(src, "repro.mjs"), path.join(dst, "repro.mjs"));
    writeJson(path.join(dst, "entry.json"), {
      ...prev,
      fingerprint: d.fingerprint,
      status: d.status,
      note: d.note ?? prev.note ?? "",
      title: d.title,
      severity: d.severity,
      firstSeen: prev.firstSeen ?? { runId: manifest.runId, version: manifest.version, id: d.id },
      lastSeen: { runId: manifest.runId, version: manifest.version, id: d.id },
    });
    n++;
  }
  console.log(`imported ${n} decisions into ${KNOWN_DIR}`);
}

async function replay(args) {
  const manifest = loadManifest(args.run);
  const results = [];
  for (const [fp, entry] of loadKnown()) {
    const repro = path.join(KNOWN_DIR, fp, "repro.mjs");
    if (!["fix", "later"].includes(entry.status) || !fs.existsSync(repro)) continue;
    const attempts = [];
    for (let i = 0; i < 2; i++) {
      const r = await runRepro(manifest, repro, { shotsDir: path.join(manifest.runDir, "regressions", fp), attempt: i });
      attempts.push({ reproduced: r.reproduced, observed: r.observed, error: r.error });
    }
    const status = gateStatus(attempts);
    results.push({
      fingerprint: fp,
      title: entry.title,
      decision: entry.status,
      result: { reproduced: "still-present", "not-reproduced": "looks-fixed", flaky: "flaky", error: "repro-broken" }[status],
      attempts,
    });
    console.log(`${entry.title}: ${results.at(-1).result}`);
  }
  writeJson(path.join(manifest.runDir, "regressions.json"), results);
}

const args = parseArgs();
switch (args._[0]) {
  case "import":
    await importDecisions(args);
    break;
  case "replay":
    await replay(args);
    break;
  case "list":
    for (const [fp, e] of loadKnown()) console.log(`${e.status.padEnd(5)} ${fp} ${e.severity ?? ""} ${e.title}`);
    break;
  default:
    console.error("usage: known.mjs import|replay|list ...");
    process.exit(2);
}
