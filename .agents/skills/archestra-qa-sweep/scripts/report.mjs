// Builds <run>/LEDGER.md and <run>/triage.html from findings/*/{finding,gate,verdict}.json.
// Usage: node report.mjs --run <runDir>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprint, loadKnown, loadManifest, parseArgs, readJson } from "./lib.mjs";

const SEVERITIES = ["blocker", "major", "minor", "polish"];
const args = parseArgs();
const manifest = loadManifest(args.run);
const findingsDir = path.join(manifest.runDir, "findings");
const known = loadKnown();

const rel = (p) => path.relative(manifest.runDir, p);
const listPngs = (dir) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => /\.(png|jpe?g)$/i.test(f))
        .sort()
        .map((f) => rel(path.join(dir, f)))
    : [];

const items = fs
  .readdirSync(findingsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => {
    const dir = path.join(findingsDir, d.name);
    const finding = readJson(path.join(dir, "finding.json"));
    const gate = readJson(path.join(dir, "gate.json"), null);
    const verdict = readJson(path.join(dir, "verdict.json"), null);
    const fp = fingerprint(finding, verdict);
    const prior = known.get(fp);
    const v = verdict?.verdict;
    const bucket = (() => {
      if (prior && ["wont", "nab"].includes(prior.status)) return "suppressed";
      if (verdict?.duplicateOf) return "duplicate";
      if (v === "CONFIRMED" || v === "CONFIRMED-DIFFERENT") return verdict.security || finding.category === "security" ? "security" : "confirmed";
      if (v) return "ruled-out";
      return "unverified";
    })();
    return {
      id: finding.id,
      fingerprint: fp,
      bucket,
      severity: verdict?.severity ?? finding.severity ?? "unrated",
      finding,
      gate: gate?.status ?? "not-gated",
      verdict,
      prior: prior ? { status: prior.status, firstSeen: prior.firstSeen } : null,
      shots: [...listPngs(path.join(dir, "verify-shots")), ...listPngs(path.join(dir, "shots")), ...listPngs(path.join(dir, "gate-shots"))].slice(0, 8),
      repro: fs.existsSync(path.join(dir, "repro.mjs")) ? rel(path.join(dir, "repro.mjs")) : null,
    };
  });

const byId = new Map(items.map((i) => [i.id, i]));
for (const i of items.filter((x) => x.bucket === "duplicate")) {
  const target = byId.get(i.verdict.duplicateOf);
  if (target) (target.duplicates ??= []).push(i.id);
}
const sevRank = (s) => (SEVERITIES.indexOf(s) + 1 || 99);
const sorted = (xs) => xs.sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || a.id.localeCompare(b.id));
const confirmed = sorted(items.filter((i) => i.bucket === "confirmed" || i.bucket === "security"));

const clusters = new Map();
for (const i of confirmed) {
  const file = i.verdict?.rootCause?.file;
  if (file) clusters.set(file, [...(clusters.get(file) ?? []), i]);
}
const shared = [...clusters].filter(([, xs]) => xs.length > 1);

const regressions = readJson(path.join(manifest.runDir, "regressions.json"), []);
const counts = Object.fromEntries(SEVERITIES.map((s) => [s, confirmed.filter((i) => i.severity === s).length]));

// ---------- LEDGER.md ----------
const line = (i) => {
  const rc = i.verdict?.rootCause;
  return [
    `### ${i.id} [${i.severity}] ${i.finding.title}`,
    `- **Route:** \`${i.finding.route ?? "-"}\` · role \`${i.finding.role ?? "admin"}\` · gate \`${i.gate}\` · verdict \`${i.verdict?.verdict ?? "-"}\`${i.duplicates ? ` · merged ${i.duplicates.join(", ")}` : ""}${i.prior ? ` · known (${i.prior.status}) since ${i.prior.firstSeen?.version ?? "?"}` : ""}`,
    `- **Expected:** ${i.finding.expected}`,
    `- **Actual:** ${i.verdict?.correctedActual ?? i.finding.actual}`,
    rc ? `- **Root cause:** \`${rc.file}${rc.line ? `:${rc.line}` : ""}\` ${rc.explanation ?? ""}` : null,
    i.verdict?.fixDirection ? `- **Fix direction:** ${i.verdict.fixDirection}` : null,
    i.verdict?.severityReason ? `- **Severity reason:** ${i.verdict.severityReason}` : null,
    i.repro ? `- **Repro:** \`${i.repro}\`` : null,
    i.shots.length ? `- **Screenshots:** ${i.shots.map((s) => `\`${s}\``).join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
};
const md = [
  `# QA sweep ${manifest.runId} — ${manifest.baseUrl} (v${manifest.version ?? "?"}, repo ${manifest.repoCommit ?? "?"})`,
  "",
  `| ${SEVERITIES.join(" | ")} | total confirmed | unverified | ruled out | suppressed |`,
  `|${"---|".repeat(SEVERITIES.length + 4)}`,
  `| ${SEVERITIES.map((s) => counts[s]).join(" | ")} | ${confirmed.length} | ${items.filter((i) => i.bucket === "unverified").length} | ${items.filter((i) => i.bucket === "ruled-out").length} | ${items.filter((i) => i.bucket === "suppressed").length} |`,
  "",
  regressions.length ? "## Regression replay\n" : null,
  ...regressions.map((r) => `- **${r.result}** (${r.decision}) ${r.title}`),
  "",
  "## Security (keep private — do not file publicly)",
  "",
  ...confirmed.filter((i) => i.bucket === "security").map(line),
  "",
  "## Shared root causes",
  "",
  ...shared.map(([file, xs]) => `- \`${file}\`: ${xs.map((x) => `${x.id} [${x.severity}]`).join(", ")}`),
  "",
  "## Confirmed",
  "",
  ...confirmed.filter((i) => i.bucket === "confirmed").map(line),
  "",
  "## Unverified",
  "",
  ...sorted(items.filter((i) => i.bucket === "unverified")).map((i) => `- ${i.id} [${i.severity}] ${i.finding.title} (gate: ${i.gate})`),
  "",
  "## Ruled out",
  "",
  ...items.filter((i) => i.bucket === "ruled-out").map((i) => `- ${i.id} **${i.verdict.verdict}** ${i.finding.title} — ${i.verdict.evidence ?? ""}`),
  "",
  "## Suppressed by baseline",
  "",
  ...items.filter((i) => i.bucket === "suppressed").map((i) => `- ${i.id} (${i.prior.status}) ${i.finding.title}`),
]
  .filter((l) => l !== null)
  .join("\n");
fs.writeFileSync(path.join(manifest.runDir, "LEDGER.md"), `${md}\n`);

// ---------- triage.html ----------
const links = (i) => [...new Set([i.finding.route, ...(i.finding.links ?? [])].filter((l) => l && l.startsWith("/") && !l.startsWith("/api")))];
const data = [...confirmed, ...sorted(items.filter((i) => i.bucket === "unverified")), ...items.filter((i) => ["ruled-out", "suppressed"].includes(i.bucket))].map((i) => ({
  id: i.id,
  ids: [i.id, ...(i.duplicates ?? [])],
  fingerprint: i.fingerprint,
  bucket: i.bucket,
  severity: i.severity,
  title: i.finding.title,
  area: i.finding.area,
  role: i.finding.role ?? "admin",
  gate: i.gate,
  verdict: i.verdict?.verdict ?? null,
  prior: i.prior,
  links: links(i),
  shots: i.shots,
  fields: [
    ["Expected", i.finding.expected],
    ["Actual", i.verdict?.correctedActual ?? i.finding.actual],
    ["Steps", (i.finding.steps ?? []).join(" → ")],
    ["Verifier evidence", i.verdict?.evidence],
    ["Root cause", i.verdict?.rootCause && `${i.verdict.rootCause.file}${i.verdict.rootCause.line ? `:${i.verdict.rootCause.line}` : ""} ${i.verdict.rootCause.explanation ?? ""}`],
    ["Fix direction", i.verdict?.fixDirection],
    ["Severity reason", i.verdict?.severityReason],
    ["Repro", i.repro],
  ].filter(([, v]) => v),
}));
const template = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "triage.template.html"), "utf8");
const html = template
  .replace("__DATA__", JSON.stringify(data).replace(/</g, "\\u003c"))
  .replace("__BASE__", manifest.baseUrl)
  .replace("__RUN__", `${manifest.runId} · v${manifest.version ?? "?"}`)
  .replace("__STORE__", `archestra-qa-triage-${manifest.runId}`);
fs.writeFileSync(path.join(manifest.runDir, "triage.html"), html);
console.log(`LEDGER.md + triage.html → ${manifest.runDir} (${confirmed.length} confirmed: ${JSON.stringify(counts)})`);
