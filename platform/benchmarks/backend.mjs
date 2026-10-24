import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { benchmarkPorts } from "./ports.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ports = benchmarkPorts(process.argv[3]);
const options = process.argv.slice(4);
const cpuProfile = options.includes("--cpu-profile");
const workersArg = options.find((arg) => /^--web-workers=[1-4]$/.test(arg));
const workers = Number(workersArg?.split("=")[1] ?? 1);
if (options.some((arg) => arg !== "--cpu-profile" && arg !== workersArg))
  throw new Error("Unknown backend launcher arguments");
if ((cpuProfile || workersArg) && process.argv[2] !== "serve")
  throw new Error("Profiling and web workers are only supported for serve");
if (cpuProfile && workers > 1)
  throw new Error("Profile one web process at a time");
// The backend loads platform/.env itself. Require a clean worktree so a
// benchmark never inherits deployment credentials or enables integrations.
if (existsSync(path.join(root, ".env")))
  throw new Error(
    "Use a separate worktree without platform/.env for the isolated benchmark",
  );
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  KUBECONFIG: "/dev/null",
  NODE_ENV: "production",
  ARCHESTRA_INTERNAL_API_BASE_URL: `http://127.0.0.1:${ports.backend}`,
  ARCHESTRA_API_BASE_URL: `http://127.0.0.1:${ports.backend}`,
  ARCHESTRA_FRONTEND_URL: "http://127.0.0.1:13000",
  ARCHESTRA_METRICS_PORT: String(ports.metrics),
  ARCHESTRA_DATABASE_URL: `postgresql://benchmark:benchmark@127.0.0.1:${ports.postgres}/benchmark`,
  ARCHESTRA_DATABASE_POOL_MAX: "20",
  ARCHESTRA_OPENAI_BASE_URL: `http://127.0.0.1:${ports.mock}/v1`,
  ARCHESTRA_AUTH_SECRET: "local-benchmark-secret-at-least-32-characters",
  ARCHESTRA_AUTH_ADMIN_EMAIL: "admin@example.com",
  ARCHESTRA_AUTH_ADMIN_PASSWORD: "local-benchmark-password",
  ARCHESTRA_ANALYTICS: "disabled",
  ARCHESTRA_CODE_RUNTIME_ENABLED: "false",
  ARCHESTRA_PROCESS_TYPE: "web",
};

async function run(command, args) {
  const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
  const stop = () => child.kill("SIGTERM");
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        code === 0
          ? resolve()
          : reject(new Error(`${command} exited ${code ?? signal}`)),
      );
    });
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

if (process.argv[2] === "prepare") {
  await run("pnpm", [
    "--recursive",
    "--filter=./archestra-rs/*",
    "--workspace-concurrency=1",
    "run",
    "build:dev",
  ]);
  await run("pnpm", ["--dir", "backend", "exec", "tsdown"]);
  await run("pnpm", ["--dir", "backend", "db:migrate"]);
} else if (process.argv[2] === "serve") {
  const args = [];
  if (cpuProfile) {
    const directory = path.join(root, "benchmarks/results/profile");
    mkdirSync(directory, { recursive: true });
    args.push(
      "--cpu-prof",
      `--cpu-prof-dir=${directory}`,
      "--cpu-prof-name=backend.cpuprofile",
    );
  }
  if (workers > 1) {
    const readyFile = path.join(
      root,
      `benchmarks/results/workers-${ports.backend}.json`,
    );
    await run(process.execPath, [
      "benchmarks/web-cluster.mjs",
      path.join(root, "backend/dist/server.mjs"),
      String(workers),
      String(ports.metrics),
      readyFile,
    ]);
  } else await run(process.execPath, [...args, "backend/dist/server.mjs"]);
} else {
  throw new Error("Usage: node benchmarks/backend.mjs prepare|serve");
}
