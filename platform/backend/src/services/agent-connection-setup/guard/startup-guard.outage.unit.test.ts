import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { STARTUP_GUARD_INSTALL } from "@archestra/shared/consts";
import { expect, test } from "vitest";
import { CLAUDE_CODE_GUARD_CLIENT } from "./clients";
import { renderStartupGuardScript } from "./startup-guard";

const exec = promisify(execFile);
// Exercise real curl and generated shell code against a disposable endpoint.
// Send Enter only after the retry/summary prompt, reproducing the destructive
// default without operating a developer's installed client or shell profiles.
const driver = `import os, select, sys, time
pid, master = os.forkpty()
if pid == 0:
    os.execvp(sys.argv[1], [sys.argv[1], sys.argv[2]])
out = b''
sent = False
end = time.time() + 25
while time.time() < end:
    r, _, _ = select.select([master], [], [], 1)
    if not r: continue
    try: chunk = os.read(master, 65536)
    except OSError: break
    if not chunk: break
    out += chunk
    if not sent and (b'Press [Enter]' in out or b'(Y/n)' in out):
        os.write(master, b'\\r')
        sent = True
else:
    os.kill(pid, 9)
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(out)
sys.exit(os.waitstatus_to_exitcode(status))
`;

test.each<[string, boolean | "timeout"]>([
  ["/bin/bash", true],
  ["/bin/bash", "timeout"],
  ["/bin/bash", false],
  ...(existsSync("/opt/homebrew/bin/bash")
    ? [["/opt/homebrew/bin/bash", true] as [string, boolean | "timeout"]]
    : []),
])(
  "transport outage preserves installation and next launch reconnects (%s, health=%s)",
  async (shell, health) => {
    const home = await mkdtemp(path.join(tmpdir(), "archestra-outage-"));
    const server = createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end('{"llm":"ok","mcp":"ok"}');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing port");
    const port = address.port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`;
    const guard = path.join(
      home,
      STARTUP_GUARD_INSTALL["claude-code"].scriptRelpath,
    );
    const bin = path.join(home, "bin");
    const settings = path.join(home, ".claude/settings.json");
    const profiles = [
      ".bashrc",
      ".zshrc",
      ".bash_profile",
      ".bash_login",
      ".profile",
    ];
    try {
      await mkdir(path.dirname(guard), { recursive: true });
      await mkdir(path.dirname(settings), { recursive: true });
      await mkdir(bin);
      await writeFile(
        settings,
        JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: `${origin}/proxy`,
            ANTHROPIC_AUTH_TOKEN: "test-key",
          },
        }),
      );
      for (const profile of profiles) {
        await writeFile(
          path.join(home, profile),
          `sentinel\n${CLAUDE_CODE_GUARD_CLIENT.markerStart}\nwrapper\n${CLAUDE_CODE_GUARD_CLIENT.markerEnd}\n`,
        );
      }
      await writeFile(
        path.join(bin, "claude"),
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/removals"\n',
      );
      await chmod(path.join(bin, "claude"), 0o755);
      await writeFile(
        guard,
        renderStartupGuardScript(
          {
            appName: "Archestra",
            healthUrl: health ? `${origin}/health` : null,
            proxy: {
              provider: "anthropic",
              providerLabel: "Anthropic",
              url: `${origin}/proxy`,
              ref: "test",
              proxyName: "test",
            },
            mcp: null,
            skills: null,
          },
          CLAUDE_CODE_GUARD_CLIENT,
        ).replace(
          "RETRY_TOTAL_SECONDS=15",
          health === "timeout"
            ? "RETRY_TOTAL_SECONDS=0"
            : "RETRY_TOTAL_SECONDS=15",
        ),
      );
      const files = [
        guard,
        settings,
        ...profiles.map((p) => path.join(home, p)),
      ];
      const before = await Promise.all(files.map((f) => readFile(f, "utf8")));
      const env = {
        ...process.env,
        HOME: home,
        CLAUDE_CONFIG_DIR: "",
        PATH: `${bin}:${process.env.PATH}`,
      };
      const first = await exec("python3", ["-c", driver, shell, guard], {
        env,
        timeout: 30_000,
      });
      expect(first.stdout).toContain("connections stay configured");
      expect(first.stdout).not.toContain("Disconnected");
      expect(await Promise.all(files.map((f) => readFile(f, "utf8")))).toEqual(
        before,
      );
      await expect(
        readFile(
          path.join(home, STARTUP_GUARD_INSTALL["claude-code"].skipRelpath),
        ),
      ).rejects.toThrow();
      await expect(readFile(path.join(home, "removals"))).rejects.toThrow();
      await new Promise<void>((resolve) =>
        server.listen(port, "127.0.0.1", resolve),
      );
      const next = await exec("python3", ["-c", driver, shell, guard], {
        env,
        timeout: 30_000,
      });
      expect(next.stdout).toContain("LLM proxy (Anthropic)");
      expect(next.stdout).not.toContain("Failed to connect");
      expect(next.stdout).not.toContain("Instance unreachable");
      expect(await Promise.all(files.map((f) => readFile(f, "utf8")))).toEqual(
        before,
      );
    } finally {
      if (server.listening)
        await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  },
  40_000,
);
