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
    const invoke = (command: string) =>
      spawnSync(
        shell,
        shell === "zsh"
          ? ["-df", "-c", command]
          : ["--noprofile", "--norc", "-O", "expand_aliases", "-c", command],
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
    writeFileSync(path.join(root, "connection.json"), "{}");
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
