import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { SetupScriptContext } from "../types";
import { nodeScriptRenderers } from "./node-script";

const context: SetupScriptContext = {
  clientId: "pi",
  platform: "windows",
  appName: "Test",
  skills: null,
  mcp: null,
  proxy: null,
};
const directories: string[] = [];
const marker =
  "payload with \"quotes\", 'apostrophe', $dollar, `tick`, café 東京";
const payload = `const fs = require("node:fs");
fs.writeFileSync(process.env.ARCH_NODE_RESULT, JSON.stringify({
  marker: ${JSON.stringify(marker)},
  cwd: process.cwd(),
  file: __filename,
  args: process.argv.slice(2)
}));
process.exitCode = Number(process.env.ARCH_NODE_EXIT || 0);
`;
const shells =
  process.platform === "win32" ? ["powershell.exe", "pwsh.exe"] : ["pwsh"];
const availableShells = shells.filter(
  (shell) =>
    spawnSync(shell, ["-NoProfile", "-Command", "exit 0"]).status === 0,
);

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test("the reported quote-stripped native argument fails before executing Node code", () => {
  const reportedArgument =
    "eval(Buffer.from(require(node:fs).readFileSync(0, utf8).trim(), base64).toString(utf8))";
  const result = spawnSync(process.execPath, ["-e", reportedArgument], {
    encoding: "utf8",
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("SyntaxError");
});

test("Windows transports exact UTF-8 bytes without JavaScript in native arguments", () => {
  const script = nodeScriptRenderers(() => payload)
    .powerShell.sections(context)
    .join("\n");
  const encoded = script.match(/^\$archNodeScript = '([A-Za-z0-9+/=]+)'/);
  expect(encoded).not.toBeNull();
  const bytes = Buffer.from(encoded?.[1] ?? "", "base64");
  expect(bytes).toEqual(Buffer.from(payload, "utf8"));
  // This is the native-argument boundary that broke on Windows PowerShell.
  expect(script.match(/^\s*& node .*$/gm)).toEqual(["  & node $archNodePath"]);
  expect(script).not.toMatch(/\bnode\s+-(?:e|p|c)\b/);
  expect(script).not.toContain(marker);

  const fixture = makeFixture();
  const file = path.join(fixture.temp, "payload [with spaces] café 東京.cjs");
  writeFileSync(file, bytes);
  const result = spawnSync(process.execPath, [file], {
    cwd: fixture.cwd,
    env: fixture.env,
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(fixture.result, "utf8"))).toEqual({
    marker,
    cwd: fixture.cwd,
    file,
    args: [],
  });
  expect(result.stdout + result.stderr).not.toContain(marker);
});

test.skipIf(process.platform === "win32")(
  "POSIX still executes the original UTF-8 stdin payload and preserves its failure status",
  () => {
    const fixture = makeFixture();
    const script = nodeScriptRenderers(() => payload)
      .bash.sections(context)
      .join("\n");
    const result = spawnSync("bash", ["-s"], {
      input: script,
      cwd: fixture.cwd,
      env: { ...fixture.env, ARCH_NODE_EXIT: "23" },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(23);
    expect(JSON.parse(readFileSync(fixture.result, "utf8"))).toMatchObject({
      marker,
      cwd: fixture.cwd,
      args: [],
    });
    expect(readdirSync(fixture.temp)).toEqual([]);
    expect(result.stdout + result.stderr).not.toContain(marker);
  },
);

// Real shell tests run on Windows PowerShell 5.1 when available, as well as
// pwsh (including the repository's Linux CI PowerShell installation). Do not
// emulate PowerShell syntax or report Node-only checks as Windows execution.
describe.skipIf(availableShells.length === 0)(
  "real PowerShell transport",
  () => {
    for (const shell of availableShells.length
      ? availableShells
      : shells.slice(0, 1)) {
      test.each([
        0, 23,
      ])(`${shell}: preserves payload/cwd and removes the temporary file after exit %i`, (exitCode) => {
        const fixture = makeFixture();
        const script = renderScript();
        const result = runPowerShell({
          shell,
          fixture,
          script,
          env: { ARCH_NODE_EXIT: String(exitCode) },
        });
        expect(result.status === 0, result.stderr).toBe(exitCode === 0);
        const observed = JSON.parse(readFileSync(fixture.result, "utf8"));
        expect(observed).toMatchObject({
          marker,
          cwd: fixture.cwd,
          args: [],
        });
        expect(path.dirname(observed.file)).toBe(fixture.temp);
        expect(path.extname(observed.file)).toBe(".cjs");
        expect(existsSync(observed.file)).toBe(false);
        expect(readdirSync(fixture.temp)).toEqual([]);
        expect(existsSync(fixture.success)).toBe(exitCode === 0);
        expect(result.stdout + result.stderr).not.toContain(marker);
        if (exitCode !== 0)
          expect(result.stdout + result.stderr).toContain(
            "Connection setup failed (exit 23)",
          );
      });

      test(`${shell}: removes its payload after a launch exception`, () => {
        const fixture = makeFixture();
        const result = runPowerShell({
          shell,
          fixture,
          script: `function node { throw 'Node launch failed' }\n${renderScript()}`,
        });
        expect(result.status).not.toBe(0);
        expect(existsSync(fixture.result)).toBe(false);
        expect(existsSync(fixture.success)).toBe(false);
        expect(readdirSync(fixture.temp)).toEqual([]);
        expect(result.stdout + result.stderr).not.toContain(marker);
      });
    }
  },
);

function renderScript() {
  return nodeScriptRenderers(() => payload)
    .powerShell.sections(context)
    .join("\n");
}

function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pi transport "));
  directories.push(root);
  const cwd = path.join(root, "cwd [spaces] café 東京");
  const temp = path.join(root, "temp [spaces] café 東京");
  mkdirSync(cwd);
  mkdirSync(temp);
  const result = path.join(root, "result.json");
  const success = path.join(root, "success");
  return {
    root,
    cwd,
    temp,
    result,
    success,
    env: {
      ...process.env,
      TEMP: temp,
      TMP: temp,
      TMPDIR: temp,
      ARCH_NODE_RESULT: result,
      ARCH_NODE_SUCCESS: success,
    },
  };
}

function runPowerShell({
  shell,
  fixture,
  script,
  env,
}: {
  shell: string;
  fixture: ReturnType<typeof makeFixture>;
  script: string;
  env?: Record<string, string>;
}) {
  const file = path.join(fixture.root, "setup with spaces.ps1");
  // A BOM lets Windows PowerShell 5.1 read a UTF-8 test script consistently.
  writeFileSync(
    file,
    `\uFEFF$ErrorActionPreference = 'Stop'\n$PSNativeCommandUseErrorActionPreference = $false\n${script}\n[System.IO.File]::WriteAllText($env:ARCH_NODE_SUCCESS, 'done')\n`,
  );
  return spawnSync(
    shell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      file,
    ],
    {
      cwd: fixture.cwd,
      env: { ...fixture.env, ...env },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
}
