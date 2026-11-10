import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import { GROK_SHELL } from "./grok-shell";

const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const hasPowerShell =
  spawnSync(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$PSVersionTable.PSVersion.ToString()",
    ],
    { encoding: "utf8" },
  ).status === 0;

function shellFixture(platform: "linux" | "darwin" | "win32") {
  const home = mkdtempSync(path.join(tmpdir(), "grok shell $& [日本語] ' "));
  const require = createRequire(import.meta.url);
  const root = path.join(home, ".archestra/grok");
  mkdirSync(root, { recursive: true });
  const profile = path.join(
    home,
    platform === "win32" ? "Documents/PowerShell/profile.ps1" : ".bashrc",
  );
  mkdirSync(path.dirname(profile), { recursive: true });
  const original = "# existing user profile\n";
  writeFileSync(profile, original);
  const run = (state: unknown, install = true) =>
    runInNewContext(`${GROK_SHELL}\ngrokShellChanges(state, install)`, {
      fs: require("node:fs"),
      path,
      Buffer,
      state,
      install,
      process: { platform, execPath: process.execPath },
      grokFile: (file: string) =>
        existsSync(file) ? readFileSync(file) : null,
      require: (name: string) => {
        if (name === "node:os") return { homedir: () => home };
        if (name === "node:child_process")
          return {
            spawnSync: () => ({
              status: 0,
              stdout: JSON.stringify(path.join(home, "Documents")),
            }),
          };
        return require(name);
      },
    }) as {
      changes: { file: string; content: Buffer | null }[];
      profiles: { file: string; block: string; before: string | null }[];
    };
  const apply = (changes: { file: string; content: Buffer | null }[]) => {
    for (const change of changes)
      if (change.content === null) rmSync(change.file, { force: true });
      else writeFileSync(change.file, change.content);
  };
  return {
    home,
    profile,
    original,
    run,
    apply,
    close: () => rmSync(home, { recursive: true, force: true }),
  };
}

test.each([
  "linux",
  "darwin",
  "win32",
] as const)("managed grok shell installation is idempotent and preserves later edits on disconnect (%s)", (platform) => {
  const { profile, original, run, apply, close } = shellFixture(platform);
  try {
    const first = run(null);
    apply(first.changes);
    const state = { shellProfiles: first.profiles };
    const installed = readFileSync(profile);
    if (platform === "win32")
      expect([...installed.subarray(0, 3)]).toEqual([239, 187, 191]);
    const again = run(state);
    apply(again.changes);
    expect(readFileSync(profile)).toEqual(installed);
    writeFileSync(
      profile,
      Buffer.concat([installed, Buffer.from("# later edit\n")]),
    );
    const disconnected = run({ shellProfiles: again.profiles }, false);
    apply(disconnected.changes);
    expect(readFileSync(profile, "utf8").replace(/^\uFEFF/, "")).toBe(
      `${original}# later edit\n`,
    );
    expect(
      first.changes
        .filter((change) => change.file !== profile)
        .every((change) => !existsSync(change.file)),
    ).toBe(true);
  } finally {
    close();
  }
});

test.each(
  (["linux", "darwin", "win32"] as const).flatMap((platform) =>
    (["\n", "\r\n"] as const).flatMap((newline) =>
      (platform === "win32"
        ? (["utf8", "utf16le"] as const)
        : (["utf8"] as const)
      ).map((encoding) => ({ platform, newline, encoding })),
    ),
  ),
)("$platform reconnect and disconnect accept $encoding newline conversion without changing surrounding profile text ($newline)", ({
  platform,
  newline,
  encoding,
}) => {
  const { profile, run, apply, close } = shellFixture(platform);
  try {
    if (encoding === "utf16le")
      writeFileSync(profile, "\uFEFF# existing user profile\n", encoding);
    const first = run(null);
    apply(first.changes);
    const converted = readFileSync(profile, encoding).replace(
      /\r?\n/g,
      newline,
    );
    const addition = `# later edit${newline}`;
    writeFileSync(profile, converted + addition, encoding);
    const previous = first.profiles.find((entry) => entry.file === profile);
    expect(previous).toBeDefined();
    const savedBlock = previous?.block ?? "";
    const convertedBlock = savedBlock.replace(/\r?\n/g, newline);
    const outside = (converted + addition).replace(convertedBlock, "");
    // Earlier installers saved mixed CRLF body lines and an LF terminator.
    const oldState = {
      shellProfiles: first.profiles.map((entry) => ({
        ...entry,
        block: entry.block.replace(/\r\n$/, "\n"),
      })),
    };
    const directDisconnect = run(oldState, false);
    expect(
      directDisconnect.changes.find((entry) => entry.file === profile)?.content,
    ).toEqual(Buffer.from(outside, encoding));
    const again = run(oldState);
    apply(again.changes);
    const updatedBlock = again.profiles.find(
      (entry) => entry.file === profile,
    )?.block;
    expect(updatedBlock).toBeTruthy();
    expect(
      readFileSync(profile, encoding).replace(updatedBlock ?? "", ""),
    ).toBe(outside);
    apply(run({ shellProfiles: again.profiles }, false).changes);
    expect(readFileSync(profile)).toEqual(Buffer.from(outside, encoding));
  } finally {
    close();
  }
});

test.each(
  (["linux", "darwin", "win32"] as const).flatMap((platform) =>
    ["changed command", "duplicate block"].map((edit) => ({ platform, edit })),
  ),
)("$platform reconnect refuses $edit while leaving the profile intact", ({
  platform,
  edit,
}) => {
  const { profile, run, apply, close } = shellFixture(platform);
  try {
    const first = run(null);
    apply(first.changes);
    const installed = readFileSync(profile, "utf8").replace(/\r?\n/g, "\n");
    const block =
      first.profiles.find((entry) => entry.file === profile)?.block ?? "";
    const changed =
      edit === "changed command"
        ? installed.replace(
            platform === "win32" ? "function global:grok" : "grok()",
            platform === "win32"
              ? "function global:custom_grok"
              : "custom_grok()",
          )
        : installed + block.replace(/\r?\n/g, "\n");
    writeFileSync(profile, changed);
    for (const install of [true, false]) {
      expect(() => run({ shellProfiles: first.profiles }, install)).toThrow(
        /shell function changed/,
      );
      expect(readFileSync(profile, "utf8")).toBe(changed);
    }
  } finally {
    close();
  }
});

test.each([
  ["bash", "linux"],
  ["zsh", "darwin"],
] as const)("%s profile routes Grok and its colocated agent through the launcher, with native fallback after disconnect or PATH changes (%s)", (shell, platform) => {
  const { home, run, apply, close } = shellFixture(platform);
  try {
    const root = path.join(home, ".archestra/grok");
    const bin = path.join(home, "bin");
    const other = path.join(home, "other");
    mkdirSync(bin);
    mkdirSync(other);
    const executable = (file: string, source: string, status = 0) =>
      writeFileSync(
        file,
        `#!${process.execPath}\nconsole.log(JSON.stringify({source:${JSON.stringify(source)},args:process.argv.slice(2)}));process.exitCode=${status};`,
        { mode: 0o700 },
      );
    executable(path.join(root, "launch.cjs"), "managed");
    executable(path.join(bin, "grok"), "native-grok", 7);
    symlinkSync(path.join(bin, "grok"), path.join(bin, "agent"));
    executable(path.join(other, "agent"), "unrelated-agent", 9);
    apply(run(null).changes);
    const profile = path.join(home, shell === "zsh" ? ".zshrc" : ".bashrc");
    const invoke = (command: string) => {
      const guarded = command.replaceAll(
        '. "$TEST_PROFILE";',
        '. "$TEST_PROFILE" || exit $?;',
      );
      const result = spawnSync(
        shell,
        shell === "zsh"
          ? ["-df", "-c", guarded]
          : ["--noprofile", "--norc", "-O", "expand_aliases", "-c", guarded],
        {
          env: {
            ...process.env,
            HOME: home,
            PATH: bin + path.delimiter + process.env.PATH,
            TEST_PROFILE: profile,
            TEST_OTHER_BIN: other,
            TEST_AGENT_BIN: path.join(bin, "agent"),
          },
          encoding: "utf8",
        },
      );
      expect(result.stderr).toBe("");
      return result;
    };
    writeFileSync(path.join(root, "connection.json"), "{}");
    for (const declaration of [
      "alias grok='grok --no-alt-screen'",
      "alias grok='command grok --no-alt-screen'",
    ]) {
      const aliased = invoke(
        `${declaration}; . "$TEST_PROFILE"; eval 'grok --resume custom'`,
      );
      expect(aliased.status, aliased.stderr).toBe(0);
      expect(JSON.parse(aliased.stdout)).toEqual({
        source: "managed",
        args: ["--resume", "custom"],
      });
    }
    const connected = invoke(
      ". \"$TEST_PROFILE\"; grok --resume 'two words' '日本語'; agent -p 'hello world'; test -z \"$archGrok$archAgent\"",
    );
    expect(connected.status, connected.stderr).toBe(0);
    expect(
      connected.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { source: "managed", args: ["--resume", "two words", "日本語"] },
      { source: "managed", args: ["-p", "hello world"] },
    ]);
    const laterAlias = invoke(
      '. "$TEST_PROFILE"; alias agent="printf unrelated"; \\agent --version',
    );
    expect(laterAlias.status, laterAlias.stderr).toBe(0);
    expect(JSON.parse(laterAlias.stdout)).toEqual({
      source: "managed",
      args: ["--version"],
    });
    const changedPath = invoke(
      '. "$TEST_PROFILE"; PATH="$TEST_OTHER_BIN:$PATH"; agent -p changed',
    );
    expect(changedPath.status, changedPath.stderr).toBe(9);
    expect(JSON.parse(changedPath.stdout)).toEqual({
      source: "unrelated-agent",
      args: ["-p", "changed"],
    });
    for (const declaration of [
      'agent() { printf "%s\\n" existing-function; }',
      "alias agent='printf existing-alias'",
      'PATH="$TEST_OTHER_BIN:$PATH"',
    ]) {
      const preserved = invoke(
        `${declaration}; . "$TEST_PROFILE"; eval 'agent'`,
      );
      if (declaration.startsWith("PATH")) {
        expect(preserved.status, preserved.stderr).toBe(9);
        expect(JSON.parse(preserved.stdout).source).toBe("unrelated-agent");
      } else {
        expect(preserved.status, preserved.stderr).toBe(0);
        expect(preserved.stdout.trim()).toBe(
          declaration.includes("alias")
            ? "existing-alias"
            : "existing-function",
        );
      }
    }
    rmSync(path.join(root, "connection.json"));
    for (const [command, source, status] of [
      ["grok", "native-grok", 7],
      ["agent", "native-grok", 7],
    ] as const) {
      const disconnected = invoke(`. "$TEST_PROFILE"; ${command} --version`);
      expect(disconnected.status, disconnected.stderr).toBe(status);
      expect(JSON.parse(disconnected.stdout)).toEqual({
        source,
        args: ["--version"],
      });
    }
    writeFileSync(path.join(root, "connection.json"), "{}");
    const replaced = invoke(
      '. "$TEST_PROFILE"; ln -sf "$TEST_OTHER_BIN/agent" "$TEST_AGENT_BIN"; agent --version',
    );
    expect(replaced.status, replaced.stderr).toBe(9);
    expect(JSON.parse(replaced.stdout)).toEqual({
      source: "unrelated-agent",
      args: ["--version"],
    });
    const sameDirectory = invoke('. "$TEST_PROFILE"; agent --version');
    expect(sameDirectory.status, sameDirectory.stderr).toBe(9);
    expect(JSON.parse(sameDirectory.stdout).source).toBe("unrelated-agent");
  } finally {
    close();
  }
});

// This portable harness runs the Windows profile in PowerShell on Unix.
// Its fake native executables use Unix shebangs, not Windows PE binaries.
test
  .skipIf(!hasPowerShell || process.platform === "win32")
  .each(["same", "different", "replaced"] as const)(
  "PowerShell verifies native executable ownership before wrapping and invoking agent (%s)",
  (mode) => {
    const { home, profile, run, apply, close } = shellFixture("win32");
    try {
      const root = path.join(home, ".archestra/grok");
      const bin = path.join(home, "bin");
      mkdirSync(bin);
      const grok = path.join(bin, "grok.exe");
      const agent = path.join(bin, "agent.exe");
      const replacement = path.join(home, "replacement.exe");
      const binary = (source: string) =>
        `#!${process.execPath}\nconsole.log(JSON.stringify({source:${JSON.stringify(source)},args:process.argv.slice(2)}));`;
      writeFileSync(grok, binary("native"), { mode: 0o700 });
      writeFileSync(
        agent,
        binary(mode === "different" ? "unrelated" : "native"),
        { mode: 0o700 },
      );
      writeFileSync(replacement, binary("unrelated"), { mode: 0o700 });
      writeFileSync(path.join(root, "launch.cjs"), binary("managed"));
      writeFileSync(path.join(root, "connection.json"), "{}");
      apply(run(null).changes);
      const probe = path.join(home, "probe.ps1");
      writeFileSync(
        probe,
        `
$ErrorActionPreference = 'Stop'
# Command discovery is the Windows boundary; execute the generated profile,
# file hashing, launcher and native fallback with real PowerShell.
function global:Get-Command {
  [CmdletBinding()]
  param([string]$Name, [object[]]$CommandType)
  $source = if ($Name -eq 'grok') { $env:TEST_GROK_BIN } else { $env:TEST_AGENT_BIN }
  [pscustomobject]@{ CommandType = 'Application'; Source = $source }
}
. $env:TEST_PROFILE
$wrapped = Test-Path Function:\\agent
if ($env:TEST_REPLACE -eq '1') {
  [IO.File]::WriteAllBytes($env:TEST_AGENT_BIN, [IO.File]::ReadAllBytes($env:TEST_REPLACEMENT))
}
$raw = if ($wrapped) { agent --probe 'two words' } else { & $env:TEST_AGENT_BIN --probe 'two words' }
[pscustomobject]@{ wrapped = $wrapped; reply = ($raw | ConvertFrom-Json) } | ConvertTo-Json -Compress -Depth 5
`,
      );
      const result = spawnSync(
        powershell,
        ["-NoProfile", "-NonInteractive", "-File", probe],
        {
          env: {
            ...process.env,
            TEST_PROFILE: profile,
            TEST_GROK_BIN: grok,
            TEST_AGENT_BIN: agent,
            TEST_REPLACEMENT: replacement,
            TEST_REPLACE: mode === "replaced" ? "1" : "0",
          },
          encoding: "utf8",
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        wrapped: mode !== "different",
        reply: {
          source: mode === "same" ? "managed" : "unrelated",
          args: ["--probe", "two words"],
        },
      });
    } finally {
      close();
    }
  },
);
