/** Run the real terminal screen with disposable configuration and fake remotes. */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLAUDE_CODE_GUARD_CLIENT } from "../backend/src/services/agent-connection-setup/guard/clients/claude-code";
import { renderStartupGuardScript } from "../backend/src/services/agent-connection-setup/guard/startup-guard";
import { STARTUP_GUARD_FORMAT_VERSION } from "../shared/consts";

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const scenario = process.argv[2] ?? "update";
  if (!["update", "current", "white-label", "down"].includes(scenario)) {
    throw new Error(
      "Usage: pnpm preview:startup-guard [update|current|white-label|down]",
    );
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Run this preview in an interactive terminal.");
  }
  const root = await mkdtemp(path.join(tmpdir(), "startup-guard-preview-"));
  try {
    const home = path.join(root, "home");
    const bin = path.join(root, "bin");
    const guard = path.join(home, CLAUDE_CODE_GUARD_CLIENT.scriptRelpath);
    await mkdir(path.dirname(guard), { recursive: true });
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await mkdir(bin);
    await writeFile(path.join(home, ".claude/settings.json"), "{}\n");
    const health = JSON.stringify({
      mcp: scenario === "down" ? "down" : "ok",
      llm: "ok",
      guardVersion:
        STARTUP_GUARD_FORMAT_VERSION + (scenario === "current" ? 0 : 1),
    });
    await writeFile(
      path.join(bin, "curl"),
      `#!/bin/sh\nprintf '%s' '${health}'\n`,
      { mode: 0o755 },
    );
    await writeFile(path.join(bin, "claude"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    await writeFile(
      guard,
      renderStartupGuardScript(
        {
          appName: scenario === "white-label" ? "Acme AI" : "Archestra",
          healthUrl: "https://preview.example.com/v1/health?mcp=demo&llm=demo",
          mcp: {
            serverName: "demo",
            ref: "demo",
            url: "https://preview.example.com/v1/mcp/demo",
          },
          proxy: {
            provider: "anthropic",
            providerLabel: "Anthropic",
            ref: "demo",
            proxyName: "demo",
            url: "https://preview.example.com/v1/anthropic/demo",
          },
          skills: null,
        },
        CLAUDE_CODE_GUARD_CLIENT,
      ),
    );
    console.log(
      `Terminal preview: ${scenario}. All settings and disconnect actions use a temporary home.`,
    );
    const result = spawnSync("bash", [guard], {
      stdio: "inherit",
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
        PATH: `${bin}:${process.env.PATH}`,
        ARCHESTRA_CLAUDE_GUARD: "1",
        ARCHESTRA_GUARD_ACTION: "",
      },
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    console.log(
      "Preview finished. Your real CLI configuration was not changed.",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
