// Discovers routes by following same-origin links (no route list), then probes each route per variant.
// Output: <run>/crawl/report.json (per page × variant signals) and <run>/crawl/summary.md (anomalies only).
// Usage: node crawl.mjs --run <runDir> [--role admin] [--variants light-1440,dark-1440,light-400]
//        [--max 150] [--per-pattern 2] [--start /] [--skip <regex>]
import fs from "node:fs";
import path from "node:path";
import { collect, loadManifest, openContext, parseArgs, routePattern, writeJson } from "./lib.mjs";

const args = parseArgs();
const manifest = loadManifest(args.run);
const role = args.role ?? "admin";
const variants = (args.variants ?? "light-1440,dark-1440,light-400").split(",");
const max = Number(args.max ?? 150);
const perPattern = Number(args["per-pattern"] ?? 2);
const skip = new RegExp(args.skip ?? "sign-?out|log-?out|/auth/|oauth|callback|disconnect|delete|/api/|\\.(md|txt|json|xml)$", "i");
const outDir = path.join(manifest.runDir, "crawl", role);

async function discover() {
  const { browser, context } = await openContext(manifest, { role });
  const page = await context.newPage();
  const queue = [args.start ?? "/"];
  const seen = new Set();
  const perPatternCount = new Map();
  const routes = [];
  try {
    while (queue.length && routes.length < max) {
      const route = queue.shift();
      if (seen.has(route)) continue;
      seen.add(route);
      const pattern = routePattern(route);
      if ((perPatternCount.get(pattern) ?? 0) >= perPattern) continue;
      const resp = await page.goto(route, { waitUntil: "networkidle", timeout: 30_000 }).catch(() => null);
      if (!resp) continue;
      const finalPath = new URL(page.url()).pathname + new URL(page.url()).search;
      perPatternCount.set(pattern, (perPatternCount.get(pattern) ?? 0) + 1);
      routes.push({ route, finalPath, pattern, status: resp.status() });
      const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href")));
      for (const href of hrefs) {
        const u = new URL(href, manifest.baseUrl);
        if (u.origin !== new URL(manifest.baseUrl).origin || skip.test(u.pathname + u.search)) continue;
        const rel = u.pathname + u.search;
        if (!seen.has(rel)) queue.push(rel);
      }
    }
  } finally {
    await browser.close();
  }
  return routes;
}

async function probe(routes, variant) {
  const { browser, context } = await openContext(manifest, { role, variant });
  const results = [];
  try {
    for (const r of routes) {
      const page = await context.newPage();
      const events = collect(page);
      const t0 = Date.now();
      await page.goto(r.route, { waitUntil: "networkidle", timeout: 30_000 }).catch((e) => events.pageErrors.push(`goto: ${e.message}`));
      const loadMs = Date.now() - t0;
      const layout = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const offenders = [...document.querySelectorAll("body *")]
          .filter((el) => {
            const b = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return b.width > 0 && b.right > vw + 1 && s.position !== "fixed" && !el.closest("[data-radix-scroll-area-viewport], .overflow-x-auto, .overflow-auto, table");
          })
          .slice(0, 5)
          .map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""} "${(el.textContent ?? "").trim().slice(0, 40)}"`);
        return {
          title: document.title,
          h1: document.querySelector("h1")?.textContent?.trim() ?? null,
          docOverflow: document.documentElement.scrollWidth > vw + 1,
          offenders,
          textLength: document.body.innerText.trim().length,
        };
      });
      const shot = path.join(outDir, variant, `${r.pattern.replace(/[/:]/g, "_") || "_root"}.png`);
      fs.mkdirSync(path.dirname(shot), { recursive: true });
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      results.push({ ...r, variant, loadMs, ...layout, ...events, screenshot: path.relative(manifest.runDir, shot) });
      await page.close();
    }
  } finally {
    await browser.close();
  }
  return results;
}

const routes = await discover();
const report = [];
for (const v of variants) report.push(...(await probe(routes, v)));
writeJson(path.join(outDir, "report.json"), { role, variants, routes, report });

const anomalies = report.filter(
  (p) => p.status >= 400 || p.console.length || p.pageErrors.length || p.failed.length || p.docOverflow || p.offenders.length || p.textLength < 20,
);
const lines = [
  `# Crawl (${role}) — ${routes.length} routes × ${variants.length} variants, ${anomalies.length} anomalous page-variants`,
  "",
  "Signals, not findings: an explorer or verifier must reproduce and judge each before filing.",
  "",
  "| route | variant | status | signals | screenshot |",
  "|---|---|---|---|---|",
  ...anomalies.map((p) => {
    const sig = [
      p.console.length && `console×${p.console.length}`,
      p.pageErrors.length && `pageerror×${p.pageErrors.length}`,
      p.failed.length && `failed:${[...new Set(p.failed.map((f) => f.status))].join("/")}`,
      p.docOverflow && "doc-overflow",
      p.offenders.length && `offscreen:${p.offenders[0]}`,
      p.textLength < 20 && "near-empty",
    ].filter(Boolean);
    return `| ${p.route} | ${p.variant} | ${p.status} | ${sig.join(", ")} | ${p.screenshot} |`;
  }),
  "",
  "## Titles",
  "",
  ...[...new Map(report.filter((p) => p.variant === variants[0]).map((p) => [p.pattern, `- ${p.pattern} → "${p.title}" / h1 "${p.h1 ?? ""}"`])).values()],
];
fs.writeFileSync(path.join(outDir, "summary.md"), `${lines.join("\n")}\n`);
console.log(`crawled ${routes.length} routes; ${anomalies.length} anomalous page-variants → ${path.join(outDir, "summary.md")}`);
