// Shared helpers for the QA sweep scripts and for agent-written repro/probe scripts.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SKILL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.resolve(SKILL_DIR, "../../..");

export const VARIANTS = {
  "light-1440": { viewport: { width: 1440, height: 900 }, colorScheme: "light" },
  "dark-1440": { viewport: { width: 1440, height: 900 }, colorScheme: "dark" },
  "light-768": { viewport: { width: 768, height: 1024 }, colorScheme: "light" },
  "light-400": { viewport: { width: 400, height: 860 }, colorScheme: "light" },
  "dark-400": { viewport: { width: 400, height: 860 }, colorScheme: "dark" },
};

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      args._.push(a);
      continue;
    }
    const [key, inline] = a.slice(2).split("=", 2);
    const next = argv[i + 1];
    args[key] = inline ?? (next === undefined || next.startsWith("--") ? true : (i++, next));
  }
  return args;
}

// Resolves Playwright from the platform workspace. ARCHESTRA_QA_PLATFORM overrides it, e.g. when
// running from a worktree without node_modules.
export function playwright() {
  const platform = process.env.ARCHESTRA_QA_PLATFORM ?? path.join(REPO_ROOT, "platform");
  const req = createRequire(path.join(platform, "e2e-tests", "package.json"));
  try {
    return req("@playwright/test");
  } catch {
    throw new Error(
      `Cannot resolve @playwright/test from ${platform}/e2e-tests. Run pnpm install there, or set ARCHESTRA_QA_PLATFORM to a platform/ checkout that has node_modules.`,
    );
  }
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (fallback !== undefined && err.code === "ENOENT") return fallback;
    throw err;
  }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

export function loadManifest(runDir) {
  if (!runDir) throw new Error("--run <runDir> is required");
  const manifest = readJson(path.join(runDir, "manifest.json"));
  return { ...manifest, runDir: path.resolve(runDir) };
}

export function saveManifest(manifest) {
  const { runDir, ...rest } = manifest;
  writeJson(path.join(runDir, "manifest.json"), rest);
}

export function rolePath(manifest, role) {
  const state = manifest.roles?.[role]?.state;
  if (!state) throw new Error(`Role "${role}" has no storage state; log it in with login.mjs first`);
  return path.join(manifest.runDir, state);
}

export function gitCommit() {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: REPO_ROOT }).toString().trim();
  } catch {
    return null;
  }
}

/** Opens an isolated browser context for a role and variant. Caller closes `browser`. */
export async function openContext(manifest, { role = "admin", variant = "light-1440", headless = true } = {}) {
  const { chromium } = playwright();
  const spec = VARIANTS[variant];
  if (!spec) throw new Error(`Unknown variant ${variant}; known: ${Object.keys(VARIANTS).join(", ")}`);
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    baseURL: manifest.baseUrl,
    storageState: role === "anonymous" ? undefined : rolePath(manifest, role),
    viewport: spec.viewport,
    colorScheme: spec.colorScheme,
  });
  return { browser, context };
}

/** Records console errors, uncaught page errors and failed responses for one page. */
export function collect(page) {
  const events = { console: [], pageErrors: [], failed: [] };
  page.on("console", (m) => m.type() === "error" && events.console.push(m.text().slice(0, 500)));
  page.on("pageerror", (e) => events.pageErrors.push(String(e).slice(0, 500)));
  page.on("response", (r) => {
    if (r.status() >= 400) events.failed.push({ status: r.status(), method: r.request().method(), url: r.url() });
  });
  return events;
}

/** Pattern used for dedupe and coverage: ids and numbers collapse to placeholders. */
export function routePattern(urlOrPath) {
  const u = new URL(urlOrPath, "http://x");
  const p = u.pathname
    .split("/")
    .map((seg) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) || /^\d+$/.test(seg) || /^[0-9a-f]{16,}$/i.test(seg)
        ? ":id"
        : seg,
    )
    .join("/");
  return p || "/";
}

/** Runs one repro module in a fresh context. Returns { reproduced, observed, error, events }. */
export async function runRepro(manifest, reproFile, { shotsDir, attempt = 0 } = {}) {
  const mod = await import(`${pathToFileURL(path.resolve(reproFile)).href}?t=${Date.now()}`);
  const meta = { role: "admin", variant: "light-1440", ...(mod.meta ?? {}) };
  const { browser, context } = await openContext(manifest, meta);
  const page = await context.newPage();
  const events = collect(page);
  let shotN = 0;
  const shot = async (name = "shot") => {
    if (!shotsDir) return null;
    fs.mkdirSync(shotsDir, { recursive: true });
    const file = path.join(shotsDir, `a${attempt}-${String(++shotN).padStart(2, "0")}-${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  };
  try {
    const result = await mod.default({
      page,
      context,
      api: context.request,
      apiUrl: manifest.apiUrl,
      baseUrl: manifest.baseUrl,
      prefix: manifest.prefix,
      manifest,
      shot,
      events,
    });
    if (typeof result?.reproduced !== "boolean") throw new Error("repro must return { reproduced: boolean, observed: string }");
    return { reproduced: result.reproduced, observed: String(result.observed ?? ""), events };
  } catch (err) {
    await shot("error").catch(() => {});
    return { reproduced: null, observed: "", error: String(err?.stack ?? err).slice(0, 2000), events };
  } finally {
    await browser.close();
  }
}

export const KNOWN_DIR = process.env.ARCHESTRA_QA_HOME
  ? path.join(process.env.ARCHESTRA_QA_HOME, "known")
  : path.join(os.homedir(), ".archestra-qa", "known");

export function loadKnown() {
  if (!fs.existsSync(KNOWN_DIR)) return new Map();
  return new Map(
    fs
      .readdirSync(KNOWN_DIR)
      .map((fp) => [fp, readJson(path.join(KNOWN_DIR, fp, "entry.json"), null)])
      .filter(([, e]) => e),
  );
}

/** Stable identity across runs: area + route pattern + category + root-cause file (or normalized title). */
export function fingerprint(finding, verdict) {
  const anchor = verdict?.rootCause?.file ?? finding.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const key = [finding.area, routePattern(finding.route ?? "/"), finding.category, anchor].join("|");
  return createHash("sha1").update(key).digest("hex").slice(0, 12);
}

export function gateStatus(attempts) {
  const outcomes = attempts.map((a) => (a.error ? "error" : a.reproduced ? "yes" : "no"));
  if (outcomes.every((o) => o === "yes")) return "reproduced";
  if (outcomes.every((o) => o === "no")) return "not-reproduced";
  if (outcomes.every((o) => o === "error")) return "error";
  return "flaky";
}
