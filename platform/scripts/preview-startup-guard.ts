/** Run the generated terminal screen with disposable config and a loopback renderer. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLAUDE_CODE_GUARD_CLIENT } from "../backend/src/services/agent-connection-setup/guard/clients/claude-code";
import {
  buildStartupGuardInstallSection,
  type StartupGuardContext,
} from "../backend/src/services/agent-connection-setup/guard/startup-guard";
import {
  StartupGuardArtifactRequestSchema,
  startupGuardArtifact,
} from "../backend/src/services/agent-connection-setup/guard/startup-guard-artifact";
import { STARTUP_GUARD_FORMAT_VERSION } from "../shared/consts";

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const scenario = process.argv[2] ?? "update";
  if (
    !["update", "current", "white-label", "down", "failure", "custom"].includes(
      scenario,
    )
  )
    throw new Error(
      "Usage: pnpm preview:startup-guard [update|current|white-label|down|failure|custom]",
    );
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("Run this preview in an interactive terminal.");
  const root = await mkdtemp(path.join(tmpdir(), "startup-guard-preview-"));
  let downloads = 0;
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith("/v1/health")) {
      response.end(
        JSON.stringify({
          mcp: scenario === "down" ? "down" : "ok",
          guardVersion: STARTUP_GUARD_FORMAT_VERSION,
        }),
      );
      return;
    }
    downloads++;
    if (scenario === "failure") {
      response.writeHead(503);
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify(
        startupGuardArtifact(
          StartupGuardArtifactRequestSchema.parse(
            JSON.parse(Buffer.concat(chunks).toString("utf8")),
          ),
        ),
      ),
    );
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No preview port");
    const origin = `http://127.0.0.1:${address.port}`;
    const home = path.join(root, "home");
    const bin = path.join(root, "bin");
    const guard = path.join(home, CLAUDE_CODE_GUARD_CLIENT.scriptRelpath);
    await mkdir(path.dirname(guard), { recursive: true, mode: 0o700 });
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await mkdir(bin);
    const settings =
      '{"env":{"CUSTOM":"preserved"},"permissions":{"deny":["Bash(*)"]}}\n';
    await writeFile(path.join(home, ".claude/settings.json"), settings);
    await writeFile(path.join(bin, "claude"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    const context: StartupGuardContext = {
      appName: scenario === "white-label" ? "Acme AI" : "Archestra",
      healthUrl: `${origin}/v1/health?mcp=demo`,
      mcp: { serverName: "demo", ref: "demo", url: `${origin}/v1/mcp/demo` },
      proxy: null,
      skills: {
        marketplaceName: "demo-skills",
        cloneUrl: `${origin}/skills/marketplace.git`,
        hasSkills: true,
      },
    };
    const env = {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      PATH: `${bin}:${process.env.PATH}`,
      ARCHESTRA_CLAUDE_GUARD: "1",
      ARCHESTRA_GUARD_ACTION: "",
    };
    await run(
      "bash",
      [
        "-c",
        `say() { :; }; ok() { :; }; ${buildStartupGuardInstallSection(context, CLAUDE_CODE_GUARD_CLIENT)}`,
      ],
      env,
      false,
    );
    if (scenario !== "current") {
      const previous = (await readFile(guard, "utf8")).replace(
        `GUARD_FORMAT_VERSION=${STARTUP_GUARD_FORMAT_VERSION}`,
        `GUARD_FORMAT_VERSION=${STARTUP_GUARD_FORMAT_VERSION - 1}`,
      );
      await writeFile(guard, previous);
      const state = JSON.parse(await readFile(`${guard}.update.json`, "utf8"));
      state.hashes = [createHash("sha256").update(previous).digest("hex")];
      await writeFile(`${guard}.update.json`, JSON.stringify(state), {
        mode: 0o600,
      });
      if (scenario === "custom")
        await writeFile(guard, `${previous}\n# Custom startup override\n`);
    }
    console.log(
      `Startup-check preview: ${scenario}. Disposable HOME: ${home}. Loopback fixture: ${origin}.`,
    );
    await run("bash", [guard], env, true);
    const source = await readFile(guard, "utf8");
    console.log(
      `Installed guard version: ${source.match(/^GUARD_FORMAT_VERSION=(\d+)$/m)?.[1]}. Artifact downloads: ${downloads}.`,
    );
    console.log(
      `Custom settings and deny rules: ${(await readFile(path.join(home, ".claude/settings.json"), "utf8")) === settings ? "preserved" : "CHANGED"}.`,
    );
    if (scenario === "update") {
      console.log(
        "Launching again to verify the installed version stays current:",
      );
      await run("bash", [guard], env, true);
      console.log(
        `Artifact downloads after second launch: ${downloads}. No reconnect or update prompt.`,
      );
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  terminal: boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: terminal ? "inherit" : "ignore",
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}
