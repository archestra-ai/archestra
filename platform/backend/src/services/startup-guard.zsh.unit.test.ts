import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { buildStartupGuardInstallSection } from "./startup-guard";
import { CLAUDE_CODE_GUARD_CLIENT } from "./startup-guard.clients";

const execFileAsync = promisify(execFile);

test.each([
  false,
  true,
])("preserves the startup guard after a terminal replaces claude (reinstall=%s)", async (reinstall) => {
  const home = await mkdtemp(path.join(tmpdir(), "archestra-zsh-"));
  try {
    const env = {
      HOME: home,
      ZDOTDIR: home,
      SHELL: "/bin/zsh",
      PATH: `${home}:${process.env.PATH}`,
      TERM: "dumb",
      ARCH_C_OK: "",
      ARCH_C_RESET: "",
    };
    // The terminal installs its CLI function at the first prompt, after rc
    // files. This is the boundary missed by tests that only source .zshrc.
    await writeFile(
      path.join(home, ".zshrc"),
      `autoload -Uz add-zsh-hook
terminal_startup() {
  claude() {
    command claude "$@"
  }
  add-zsh-hook -d precmd terminal_startup
}
add-zsh-hook precmd terminal_startup
`,
    );
    const install = path.join(home, "install.sh");
    await writeFile(
      install,
      `set -eu\nsay() { :; }\nok() { :; }\n${buildStartupGuardInstallSection(
        {
          appName: "Archestra",
          healthUrl: "https://example.com/health",
          proxy: null,
          skills: null,
          mcp: {
            serverName: "test_gateway",
            url: "https://example.com/mcp",
            ref: "test-gateway",
          },
        },
        CLAUDE_CODE_GUARD_CLIENT,
      )}`,
    );
    for (let i = 0; i < (reinstall ? 2 : 1); i++) {
      await execFileAsync("bash", [install], { env });
    }
    // Only the network and CLI process boundaries are faked. The generated
    // guard and wrapper, shell startup, and hooks all execute normally.
    for (const [name, body] of Object.entries({
      curl: `printf 'guard\\n' >> "$HOME/calls"\nprintf '%s' '{"mcp":"ok"}'`,
      claude: `printf 'terminal\\n' >> "$HOME/calls"\nexec "$HOME/real-cli" "$@"`,
      "real-cli": `printf 'cli:<%s>:<%s>\\n' "$1" "$2" >> "$HOME/calls"\nexit 23`,
    })) {
      const file = path.join(home, name);
      await writeFile(file, `#!/bin/sh\n${body}\n`);
      await chmod(file, 0o755);
    }
    const result = await execFileAsync(
      "python3",
      [
        "-c",
        `import subprocess
commands = '''claude 'two words' 'literal $value'
print -r -- "STATUS:$?"
source "$HOME/.zshrc"
claude 'two words' 'literal $value'
print -r -- "STATUS:$?"
print -r -- "HOOKS:$preexec_functions"
exit
'''
r = subprocess.run(['zsh', '-i'], input=commands, text=True, capture_output=True)
print(r.stdout)
print(r.stderr)
raise SystemExit(r.returncode)
`,
      ],
      { env },
    );
    expect(result.stdout.match(/STATUS:23/g)).toHaveLength(2);
    expect(result.stdout).toContain("HOOKS:\n");
    expect(
      (await readFile(path.join(home, "calls"), "utf8")).split("\n"),
    ).toEqual([
      "guard",
      "terminal",
      "cli:<two words>:<literal $value>",
      "guard",
      "terminal",
      "cli:<two words>:<literal $value>",
      "",
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
