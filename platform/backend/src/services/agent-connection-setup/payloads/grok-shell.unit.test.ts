import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import { GROK_SHELL } from "./grok-shell";

function shellFixture(platform: "linux" | "win32") {
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

test.each([
  { newline: "\n", encoding: "utf8" },
  { newline: "\r\n", encoding: "utf8" },
  { newline: "\n", encoding: "utf16le" },
  { newline: "\r\n", encoding: "utf16le" },
] as const)("Windows reconnect and disconnect accept $encoding newline conversion without changing surrounding profile text ($newline)", ({
  newline,
  encoding,
}) => {
  const { profile, run, apply, close } = shellFixture("win32");
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

test.each([
  "changed command",
  "duplicate block",
])("Windows reconnect refuses %s while leaving the profile intact", (edit) => {
  const { profile, run, apply, close } = shellFixture("win32");
  try {
    const first = run(null);
    apply(first.changes);
    const installed = readFileSync(profile, "utf8").replace(/\r?\n/g, "\n");
    const block =
      first.profiles.find((entry) => entry.file === profile)?.block ?? "";
    const changed =
      edit === "changed command"
        ? installed.replace(
            "function global:grok",
            "function global:custom_grok",
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

test("plain grok in a fresh Bash terminal runs the managed launcher and forwards arguments", () => {
  const home = mkdtempSync(path.join(tmpdir(), "grok shell invocation "));
  const require = createRequire(import.meta.url);
  try {
    const root = path.join(home, ".archestra/grok");
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "connection.json"), "{}");
    const capture = path.join(home, "argv.json");
    writeFileSync(
      path.join(root, "launch.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2)));`,
    );
    const planned = runInNewContext(
      `${GROK_SHELL}\ngrokShellChanges(null, true)`,
      {
        fs: require("node:fs"),
        path,
        Buffer,
        process: { platform: "linux", execPath: process.execPath },
        grokFile: () => null,
        require: (name: string) =>
          name === "node:os" ? { homedir: () => home } : require(name),
      },
    ) as { changes: { file: string; content: Buffer }[] };
    for (const change of planned.changes)
      writeFileSync(change.file, change.content);
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--rcfile",
        path.join(home, ".bashrc"),
        "-ic",
        "grok --resume 'two words' '日本語'",
      ],
      { env: { ...process.env, HOME: home }, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual([
      "--resume",
      "two words",
      "日本語",
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
