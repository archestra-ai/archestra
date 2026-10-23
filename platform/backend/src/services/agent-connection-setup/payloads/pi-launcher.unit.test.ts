import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { PI_COMMAND_RESOLVER, PI_LAUNCHER } from "./pi-launcher";

// Exact native pi.dev wrappers supplied for the regression, without user paths.
const nativeCmd = String.raw`@ECHO off
SETLOCAL
SET "node=node"
"%node%" "%~dp0pi-launcher.js" %*
SET "pi_exit_code=%ERRORLEVEL%"
IF "%pi_exit_code%"=="9009" (
  IF "%node%"=="node" (
    "%SystemRoot%\System32\where.exe" /Q node
    IF ERRORLEVEL 1 GOTO node_missing
  ) ELSE IF NOT EXIST "%node%" GOTO node_missing
)
EXIT /B %pi_exit_code%
:node_missing
ECHO Pi could not find Node.js. Install Node.js 22.19.0 or newer, or rerun the installer at https://pi.dev. 1>&2
EXIT /B %pi_exit_code%`;
const nativePs1 = `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent
$launcher=Join-Path $basedir "pi-launcher.js"
$node="node"
try {
  if ($MyInvocation.ExpectingInput) {
    $input | & $node $launcher $args
  } else {
    & $node $launcher $args
  }
} catch [System.Management.Automation.CommandNotFoundException] {
  [Console]::Error.WriteLine("Pi could not find Node.js. Install Node.js 22.19.0 or newer, or rerun the installer at https://pi.dev.")
  exit 127
}
exit $LASTEXITCODE`;

// npm/cmd-shim lib/index.js and @pnpm/cmd-shim emit these wrappers. Keep the
// surrounding dispatch, BOM and CRLF: a lone quoted path missed the regression.
const npmShim = (target: string) =>
  `\uFEFF@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nIF EXIST "%dp0%\\node.exe" (\r\n SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n SET "_prog=node"\r\n SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "${target}" %*\r\n`;
const bin = "C:\\Users\\Test User 日本語\\AppData\\Roaming\\npm";
const node = "C:\\Program Files\\nodejs\\node.exe";
function resolve(files: Record<string, string>, searchPath = bin) {
  const load = new Function(
    "process",
    "path",
    "fs",
    `${PI_COMMAND_RESOLVER}\nreturn piCommand;`,
  );
  return load(
    { platform: "win32", execPath: node, env: { Path: searchPath } },
    path.win32,
    {
      existsSync: (file: string) => Object.hasOwn(files, file),
      statSync: () => ({ isFile: () => true }),
      lstatSync: () => ({ isSymbolicLink: () => false }),
      realpathSync: (file: string) => file,
      readFileSync: (file: string) => files[file],
    },
  );
}
function packageFiles(root: string, entry = "dist/bundle/cli.js") {
  return {
    [path.win32.join(root, "package.json")]: JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      bin: { pi: entry },
    }),
    [path.win32.join(root, entry)]: "#!/usr/bin/env node\n// CLI fixture",
  };
}

describe("installed Pi entrypoint resolution", () => {
  test.each([
    "%dp0%",
    "%_dp0%",
    "%~dp0",
  ])("resolves the full npm Windows wrapper with %s", (prefix) => {
    const root = path.win32.join(
      bin,
      "node_modules/@earendil-works/pi-coding-agent",
    );
    const entry = "dist/bundle/cli.js";
    expect(
      resolve({
        ...packageFiles(root, entry),
        [path.win32.join(bin, "pi.cmd")]: npmShim(
          `${prefix}\\node_modules\\@earendil-works\\pi-coding-agent\\${entry.replaceAll("/", "\\")}`,
        ),
      }),
    ).toEqual([node, path.win32.join(root, entry)]);
  });

  test("follows a pnpm wrapper chain and reads bin metadata for a versioned non-cli.js entry", () => {
    const shimDir = path.win32.join(bin, "global/5/node_modules/.bin");
    const root = path.win32.join(
      shimDir,
      "../.pnpm/@earendil-works+pi-coding-agent@1.4.0/node_modules/@earendil-works/pi-coding-agent",
    );
    const entry = "bin/agent.mjs";
    const target = path.win32.relative(shimDir, path.win32.join(root, entry));
    expect(
      resolve({
        ...packageFiles(root, entry),
        [path.win32.join(bin, "pi.cmd")]:
          `@SETLOCAL\r\n@CALL "%~dp0\\global\\5\\node_modules\\.bin\\pi.CMD" %*\r\n`,
        // Windows filesystem lookup is case-insensitive; retain the exact target
        // spelling here so the fixture does not emulate a different filesystem.
        [path.win32.join(shimDir, "pi.CMD")]:
          `@SETLOCAL\r\n@IF NOT DEFINED NODE_PATH (SET "NODE_PATH=%~dp0\\node_modules")\r\n@"node" "%~dp0\\${target}" %*\r\n`,
      }),
    ).toEqual([node, path.win32.join(root, entry)]);
  });

  test("uses package bin metadata for a PowerShell shim and ignores an earlier extensionless POSIX shim on Windows", () => {
    const root = path.win32.join(
      bin,
      "node_modules/@earendil-works/pi-coding-agent",
    );
    const entry = "dist/entry.cjs";
    expect(
      resolve(
        {
          ...packageFiles(root, entry),
          "C:\\posix-only\\pi": "#!/bin/sh\nexec broken",
          [path.win32.join(bin, "pi.ps1")]:
            `\uFEFF#!/usr/bin/env pwsh\r\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\r\n& "node$exe" "$basedir/node_modules/@earendil-works/pi-coding-agent/${entry}" $args\r\nexit $LASTEXITCODE\r\n`,
        },
        `C:\\posix-only;"${bin}"`,
      ),
    ).toEqual([node, path.win32.join(root, entry)]);
  });

  test("accepts pnpm cmd-shim-target metadata with CRLF and an alternate package bin", () => {
    const root = path.win32.join(
      bin,
      "node_modules/@earendil-works/pi-coding-agent",
    );
    const entry = "bin/run.mjs";
    expect(
      resolve({
        ...packageFiles(root, entry),
        [path.win32.join(bin, "pi.ps1")]:
          `\uFEFF# cmd-shim-target=./node_modules/@earendil-works/pi-coding-agent/${entry}\r\n`,
      }),
    ).toEqual([node, path.win32.join(root, entry)]);
  });

  test.each([
    "@echo custom-wrapper",
    '@CALL "%~dp0\\pi.cmd" %*',
    '@"node" "%UNKNOWN%\\cli.js" %*',
  ])("refuses an unresolvable wrapper without invoking a shell: %s", (shim) => {
    expect(() => resolve({ [path.win32.join(bin, "pi.cmd")]: shim })).toThrow(
      "Cannot resolve",
    );
  });

  test("refuses a package bin that escapes its package", () => {
    const root = path.win32.join(
      bin,
      "node_modules/@earendil-works/pi-coding-agent",
    );
    expect(() =>
      resolve({
        ...packageFiles(root, "../../outside.js"),
        [path.win32.join(root, "dist/cli.js")]: "#!/usr/bin/env node",
        [path.win32.join(bin, "pi.cmd")]: npmShim(
          "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js",
        ),
      }),
    ).toThrow("Cannot resolve");
  });
});

describe("native pi.dev Windows installation without npm metadata", () => {
  test.each([
    ["cmd", nativeCmd],
    ["ps1", nativePs1],
  ])("resolves the exact supplied %s wrapper to its sibling Node launcher", (extension, source) => {
    const nativeBin = "C:\\Users\\Test User 日本語\\.pi\\agent\\bin";
    const launcher = path.win32.join(nativeBin, "pi-launcher.js");
    for (const bytes of [
      source,
      source.toUpperCase(),
      "\uFEFF" + source.replaceAll("\n", "\r\n"),
    ]) {
      expect(
        resolve(
          {
            [path.win32.join(nativeBin, "pi." + extension)]: bytes,
            [launcher]: "// native Pi launcher, no package.json",
          },
          nativeBin,
        ),
      ).toEqual([node, launcher]);
    }
  });
});

test.each([
  [
    "cmd",
    nativeCmd.replace("%~dp0pi-launcher.js", "%DYNAMIC%\\pi-launcher.js"),
  ],
  ["cmd", nativeCmd.replace("%~dp0pi-launcher.js", "%~dp0..\\pi-launcher.js")],
  ["cmd", nativeCmd.replace('SET "node=node"', 'SET "node=%CUSTOM_NODE%"')],
  ["cmd", nativeCmd + '\necho "pi-launcher.js"'],
  [
    "ps1",
    nativePs1.replace(
      'Join-Path $basedir "pi-launcher.js"',
      'Join-Path $env:PI_HOME "pi-launcher.js"',
    ),
  ],
  ["ps1", nativePs1.replace('"pi-launcher.js"', '"../pi-launcher.js"')],
  ["ps1", nativePs1.replace("& $node $launcher $args", "& $node $other $args")],
  ["ps1", nativePs1 + '\n$launcher = "other.js"'],
  ["cmd", '@ECHO "pi-launcher.js"'],
])("does not infer native targets from dynamic, traversing or unrelated %s wrappers", (extension, source) => {
  expect(() =>
    resolve({
      [path.win32.join(bin, "pi." + extension)]: source,
      [path.win32.join(bin, "pi-launcher.js")]:
        "// exists, but is not an authorized target",
    }),
  ).toThrow("Cannot resolve");
});

test.each([
  ["cmd", nativeCmd],
  ["ps1", nativePs1],
])("rejects a missing native launcher for %s", (extension, source) => {
  expect(() =>
    resolve({ [path.win32.join(bin, "pi." + extension)]: source }),
  ).toThrow("Cannot resolve");
});

test("native launcher resolution and arcpi preserve literal arguments and exit status without a shell", () => {
  const home = fs.mkdtempSync(path.join(tmpdir(), "pi native 日本語 "));
  try {
    const launcher = path.join(home, "pi-launcher.js");
    fs.writeFileSync(path.join(home, "pi.cmd"), nativeCmd);
    fs.writeFileSync(
      launcher,
      "process.stdout.write(JSON.stringify(process.argv.slice(2))); process.exit(23);",
    );
    // Execute the Windows resolver against a real filesystem using the host's
    // path separator. This is Node dispatch coverage, not PowerShell execution.
    const load = new Function(
      "process",
      "path",
      "fs",
      `${PI_COMMAND_RESOLVER}\nreturn piCommand;`,
    );
    const hostProcess = {
      platform: "win32",
      execPath: process.execPath,
      env: { Path: home },
      getuid: process.getuid,
    };
    const command = load(hostProcess, path, fs);
    expect(command).toEqual([process.execPath, launcher]);
    fs.mkdirSync(path.join(home, ".archestra/pi"), { recursive: true });
    const extension = path.join(home, ".pi/agent/extensions/archestra-pi.js");
    fs.mkdirSync(path.dirname(extension), { recursive: true });
    fs.writeFileSync(extension, "fixture extension");
    fs.writeFileSync(
      path.join(home, ".archestra/pi/connection.json"),
      JSON.stringify({
        piCommand: command,
        extensionSha256: createHash("sha256")
          .update("fixture extension")
          .digest("hex"),
        provider: "openai",
        model: "fixture-model",
      }),
    );
    const args = [
      "--mode",
      "json",
      "--",
      'spaces 日本語 "quoted" & $(not-a-command)',
      "trailing\\",
    ];
    const child = spawnSync(process.execPath, ["-", ...args], {
      input: PI_LAUNCHER,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: "utf8",
    });
    expect(child.status, child.stderr).toBe(23);
    expect(JSON.parse(child.stdout)).toEqual([
      "--provider",
      "archestra",
      "--model",
      "fixture-model",
      "--extension",
      extension,
      ...args,
    ]);
    fs.unlinkSync(launcher);
    const outside = path.join(home, "outside.js");
    fs.writeFileSync(outside, "// not the sibling entry");
    fs.symlinkSync(outside, launcher);
    expect(() => load(hostProcess, path, fs)).toThrow("Cannot resolve");
    fs.unlinkSync(launcher);
    fs.writeFileSync(launcher, "// regular target");
    expect(() => load({ ...hostProcess, getuid: () => -1 }, path, fs)).toThrow(
      "Cannot resolve",
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
