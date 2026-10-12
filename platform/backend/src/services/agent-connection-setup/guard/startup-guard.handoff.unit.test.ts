import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { CLAUDE_CODE_GUARD_CLIENT, OPENCODE_GUARD_CLIENT } from "./clients";
import {
  buildStartupGuardInstallSection,
  type StartupGuardContext,
} from "./startup-guard";

const exec = promisify(execFile);

test.each([
  "bash",
  "zsh",
])("%s wrapper preserves arguments, overrides, and handoff setup lifecycle", async (shell) => {
  const home = await mkdtemp(path.join(tmpdir(), "handoff home "));
  const client = CLAUDE_CODE_GUARD_CLIENT;
  const promptPath = path.join(home, `${client.scriptRelpath}.prompt.md`);
  const instructions =
    'Offer remote work.\n\'\n$(touch "$HOME/injected")\n`whoami`\n雪\nARCHESTRA_GUARD_PROFILE_EOF';
  const ctx: StartupGuardContext = {
    appName: "Test Platform",
    healthUrl: null,
    proxy: null,
    skills: null,
    mcp: {
      serverName: "gateway",
      url: "https://example.com/v1/mcp/gateway",
      ref: "gateway",
    },
    runtimeHandoffInstructions: instructions,
  };
  const env = {
    ...process.env,
    HOME: home,
    ZDOTDIR: home,
    SHELL: `/bin/${shell}`,
    PATH: `${home}:${process.env.PATH}`,
    ARCHESTRA_CLAUDE_GUARD: "0",
    ARCH_C_OK: "",
    ARCH_C_RESET: "",
  };
  const profile = shell === "zsh" ? ".zshrc" : ".bashrc";
  const install = async (context: StartupGuardContext) => {
    const script = path.join(home, "install.sh");
    await writeFile(
      script,
      `set -eu\nsay() { :; }\nok() { :; }\n${buildStartupGuardInstallSection(context, client)}`,
    );
    await exec("bash", [script], { env });
  };
  const launch = async (args: string[]) => {
    await expect(
      exec(
        shell,
        ["-c", `source "$HOME/${profile}"; claude "$@"`, "test", ...args],
        { env },
      ),
    ).rejects.toMatchObject({ code: 23 });
    return (await readFile(path.join(home, "argv"), "utf8"))
      .split("\0")
      .slice(0, -1);
  };
  try {
    await writeFile(
      path.join(home, "claude"),
      '#!/bin/sh\nprintf "%s\\0" "$@" > "$HOME/argv"\nexit 23\n',
    );
    await chmod(path.join(home, "claude"), 0o755);
    await install(ctx);
    await install(ctx);
    expect(await readFile(promptPath, "utf8")).toBe(instructions);
    await expect(readFile(path.join(home, "injected"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await readFile(path.join(home, profile), "utf8")).split(
        client.markerStart,
      ),
    ).toHaveLength(2);
    for (const args of [
      ["-p", "two words", "literal $value"],
      ["--continue"],
      ["--", "--system-prompt"],
    ]) {
      expect(await launch(args)).toEqual([
        "--append-system-prompt-file",
        promptPath,
        ...args,
      ]);
    }
    for (const flag of [
      "--system-prompt",
      "--system-prompt-file",
      "--append-system-prompt",
      "--append-system-prompt-file",
    ]) {
      for (const args of [[flag, "user value"], [`${flag}=user value`]]) {
        expect(await launch(args)).toEqual(args);
      }
    }
    for (const args of [
      ["mcp", "list"],
      ["plugin", "update"],
      ["--version"],
      ["--help"],
    ]) {
      expect(await launch(args)).toEqual(args);
    }
    await writeFile(path.join(home, client.skipRelpath), "mcp\n");
    expect(await launch(["work"])).toEqual(["work"]);
    await install({
      ...ctx,
      runtimeHandoffInstructions: "Updated instructions",
    });
    expect(await readFile(promptPath, "utf8")).toBe("Updated instructions");
    await rm(promptPath);
    expect(await launch(["work"])).toEqual(["work"]);
    await install(ctx);
    await install({ ...ctx, runtimeHandoffInstructions: null });
    await expect(readFile(promptPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await launch(["work"])).toEqual(["work"]);
    await install({ ...ctx, mcp: null });
    expect(await launch(["work"])).toEqual(["work"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test.each([
  ["bash", CLAUDE_CODE_GUARD_CLIENT],
  ["zsh", CLAUDE_CODE_GUARD_CLIENT],
  ["bash", OPENCODE_GUARD_CLIENT],
  ["zsh", OPENCODE_GUARD_CLIENT],
] as const)("%s %j wrapper refreshes before launch without reconnecting, including initially disabled instructions", async (shell, client) => {
  const { createServer } = await import("node:http");
  const home = await mkdtemp(
    path.join(tmpdir(), "instruction refresh wrapper "),
  );
  let instructions: string | null = null;
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    expect(request.headers.authorization).toBe(
      "Bearer installation-credential",
    );
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ instructions }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  const context: StartupGuardContext = {
    appName: "Test Platform",
    healthUrl: null,
    proxy: null,
    skills: null,
    mcp: {
      serverName: "gateway",
      url: "https://example.com/v1/mcp/gateway",
      ref: "gateway",
    },
    runtimeHandoffInstructions: null,
    managedInstructionsSource: {
      url: `http://127.0.0.1:${address.port}/instructions`,
      token: "installation-credential",
    },
  };
  const env = {
    ...process.env,
    HOME: home,
    ZDOTDIR: home,
    PATH: `${home}:${process.env.PATH}`,
    SHELL: `/bin/${shell}`,
    ARCHESTRA_CLAUDE_GUARD: "0",
    ARCHESTRA_OPENCODE_GUARD: "0",
  };
  const profile = shell === "zsh" ? ".zshrc" : ".bashrc";
  try {
    await writeFile(
      path.join(home, client.binary),
      client.clientId === "opencode"
        ? `#!/usr/bin/env node
(async () => {
 const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}");
 if (!config.plugin) { process.stdout.write("no-managed-instructions"); return; }
 const plugin = await import(config.plugin[0]);
 const hooks = await plugin.RuntimeHandoff({ client: { session: { get: async () => ({data: {id: "root"}}) } }, directory: process.env.HOME });
 const output = {system: []};
 await hooks["experimental.chat.system.transform"]({sessionID: "root"}, output);
 process.stdout.write(output.system.join(""));
})();
`
        : '#!/bin/sh\nif [ "$1" = "--append-system-prompt-file" ]; then cat "$2"; else printf no-managed-instructions; fi\n',
    );
    await chmod(path.join(home, client.binary), 0o755);
    const install = path.join(home, "install.sh");
    await writeFile(
      install,
      `set -eu\nsay() { :; }\nok() { :; }\n${buildStartupGuardInstallSection(context, client)}`,
    );
    await exec("bash", [install], { env });
    const launch = async (
      arg = client.clientId === "opencode" ? "run" : "-p",
    ) =>
      (
        await exec(
          shell,
          [
            "-c",
            `source "$HOME/${profile}"; ${client.binary} "$@"`,
            "test",
            arg,
          ],
          { env },
        )
      ).stdout;
    expect(await launch()).toBe("no-managed-instructions");
    instructions = "Current organization guidance";
    expect(await launch()).toBe(instructions);
    instructions = "Updated organization guidance";
    expect(await launch()).toBe(instructions);
    instructions = null;
    expect(await launch()).toBe("no-managed-instructions");
    instructions = "Enabled again";
    expect(await launch()).toBe(instructions);
    const beforeUtility = requests;
    await launch("--version");
    expect(requests).toBe(beforeUtility);
    await writeFile(path.join(home, client.skipRelpath), "mcp\n");
    expect(await launch()).toBe("no-managed-instructions");
    expect(requests).toBe(beforeUtility);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
