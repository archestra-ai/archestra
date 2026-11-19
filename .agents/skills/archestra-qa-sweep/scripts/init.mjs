// Creates a run directory + manifest for a target stack and logs in the admin role.
// Usage: node init.mjs --base http://localhost:3000 --api http://localhost:9000 [--out /tmp/archestra-qa/runs]
//        [--email admin@example.com] (password: ARCHESTRA_QA_PASSWORD env, or the dev default on localhost)
import path from "node:path";
import { gitCommit, parseArgs, saveManifest } from "./lib.mjs";
import { login } from "./login.mjs";

const args = parseArgs();
const baseUrl = (args.base ?? "http://localhost:3000").replace(/\/$/, "");
const apiUrl = (args.api ?? "http://localhost:9000").replace(/\/$/, "");
const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
const runDir = path.resolve(args.out ?? "/tmp/archestra-qa/runs", runId);

const health = await fetch(`${apiUrl}/health`).then((r) => r.json()).catch(() => null);
if (!health) throw new Error(`Backend health check failed at ${apiUrl}/health`);

const manifest = {
  runId,
  runDir,
  baseUrl,
  apiUrl,
  version: health.version ?? null,
  repoCommit: gitCommit(),
  prefix: `qa-${runId.slice(-6)}-`,
  startedAt: new Date().toISOString(),
  roles: {},
  fixtures: [],
  lanes: [],
};
saveManifest(manifest);
await login(manifest, { role: "admin", email: args.email ?? "admin@example.com", password: process.env.ARCHESTRA_QA_PASSWORD });
console.log(JSON.stringify({ runDir, version: manifest.version, prefix: manifest.prefix }, null, 2));
