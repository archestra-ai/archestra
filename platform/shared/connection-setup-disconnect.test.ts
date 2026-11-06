import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { startupGuardDisconnectCommand } from "./connection-setup";

const exec = promisify(execFile);
const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const hasPowerShell =
  spawnSync(powershell, ["-NoProfile", "-Command", "exit 0"]).status === 0;

for (const platform of ["bash", "windows"] as const) {
  describe.skipIf(
    platform === "windows" ? !hasPowerShell : process.platform === "win32",
  )(`${platform} disconnect command`, () => {
    async function fixture(guardBody?: string) {
      const home = await mkdtemp(path.join(tmpdir(), "guard disconnect "));
      const guard = path.join(
        home,
        ".archestra",
        `codex-startup-guard.${platform === "windows" ? "ps1" : "sh"}`,
      );
      if (guardBody) {
        await mkdir(path.dirname(guard));
        await writeFile(guard, guardBody);
      }
      const command = startupGuardDisconnectCommand("chatgpt", platform);
      if (!command) throw new Error("ChatGPT disconnect command missing");
      const driver = path.join(
        home,
        platform === "windows" ? "driver.ps1" : "driver.sh",
      );
      const run = async (source: string) => {
        await writeFile(
          driver,
          platform === "windows"
            ? `$ErrorActionPreference = 'Stop'\n$global:LASTEXITCODE = 29\n${source}`
            : `set -e\n${source}`,
        );
        return exec(
          platform === "windows" ? powershell : "bash",
          platform === "windows"
            ? ["-NoProfile", "-NonInteractive", "-File", driver]
            : [driver],
          {
            env: {
              ...process.env,
              HOME: home,
              USERPROFILE: home,
              ARCHESTRA_GUARD_ACTION: undefined,
            },
          },
        );
      };
      return { home, guard, command, run };
    }

    test.each([
      false,
      true,
    ])("repeated cleanup succeeds without errors (script initially absent: %s)", async (absent) => {
      const body =
        platform === "windows"
          ? `if ($env:ARCHESTRA_GUARD_ACTION -ne 'disconnect') { exit 97 }
Write-Output 'cleaned'
Remove-Item -LiteralPath $PSCommandPath
exit 0`
          : `test "$ARCHESTRA_GUARD_ACTION" = disconnect || exit 97
printf '%s\\n' cleaned
rm -- "$0"
exit 0`;
      const f = await fixture(absent ? undefined : body);
      try {
        const result = await f.run(
          `${f.command}\n${f.command}\n${f.command}${
            platform === "windows"
              ? "\nif (Test-Path Env:ARCHESTRA_GUARD_ACTION) { throw 'Temporary action leaked' }\nWrite-Output ('status=' + $LASTEXITCODE)"
              : ""
          }`,
        );
        expect(result.stderr).toBe("");
        expect(result.stdout.match(/^cleaned$/gm) ?? []).toHaveLength(
          absent ? 0 : 1,
        );
        expect(
          result.stdout.match(/No local cleanup script remains\./g),
        ).toHaveLength(absent ? 3 : 2);
        if (platform === "windows") expect(result.stdout).toContain("status=0");
        await expect(readFile(f.guard)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await rm(f.home, { recursive: true, force: true });
      }
    });

    test("a real cleanup failure remains a failure and keeps its script", async () => {
      const f = await fixture("exit 23\n");
      try {
        await expect(f.run(f.command)).rejects.toMatchObject({
          code: platform === "windows" ? 1 : 23,
        });
        expect(await readFile(f.guard, "utf8")).toBe("exit 23\n");
      } finally {
        await rm(f.home, { recursive: true, force: true });
      }
    });
  });
}
