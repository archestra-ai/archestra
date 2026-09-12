import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
  ARCHESTRA_INTERNAL_API_BASE_URL: "http://127.0.0.1:19000",
  ARCHESTRA_API_BASE_URL: "http://127.0.0.1:19000",
  ARCHESTRA_FRONTEND_URL: "http://127.0.0.1:13000",
  ARCHESTRA_METRICS_PORT: "19050",
  ARCHESTRA_DATABASE_URL:
    "postgresql://benchmark:benchmark@127.0.0.1:15432/benchmark",
  ARCHESTRA_DATABASE_POOL_MAX: "20",
  ARCHESTRA_OPENAI_BASE_URL: "http://127.0.0.1:19092/v1",
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
  await run("pnpm", ["--dir", "backend", "exec", "tsdown"]);
  await run("pnpm", ["--dir", "backend", "db:migrate"]);
} else if (process.argv[2] === "serve") {
  await run(process.execPath, ["backend/dist/server.mjs"]);
} else {
  throw new Error("Usage: node benchmarks/backend.mjs prepare|serve");
}
