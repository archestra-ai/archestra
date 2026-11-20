import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { renderSetupScript } from "./index";
import type { SetupScriptContext, SetupScriptProxySection } from "./types";

const execFileAsync = promisify(execFile);
const powershellBin = [
  ...(process.platform === "win32" ? ["powershell.exe"] : []),
  "pwsh",
].find(
  (candidate) =>
    spawnSync(candidate, ["-NoProfile", "-Command", "exit 0"], {
      timeout: 15_000,
    }).status === 0,
);
const gitBin = spawnSync("git", ["--version"]).status === 0;

const NAME = "acme-skills";

/**
 * Windows PowerShell 5.1 turns every stderr line of a native command into an
 * error record, which aborts a script under 'Stop' even when the stream is
 * redirected. pwsh no longer does, so these stand-ins replay the real
 * command's stderr through Write-Error.
 */
const WINDOWS_POWERSHELL_STDERR = `function git {
  $archTestErr = Join-Path $env:ARCHESTRA_TEST_ROOT ('git-' + [guid]::NewGuid() + '.err')
  $archTestOut = & $env:ARCHESTRA_TEST_GIT @args 2> $archTestErr
  $archTestCode = $LASTEXITCODE
  $archTestOut
  Get-Content $archTestErr | ForEach-Object { Write-Error $_ }
  $global:LASTEXITCODE = $archTestCode
}
function python3 {
  $null = @($input)
  Write-Error 'sqlite3.OperationalError: database is locked'
  $global:LASTEXITCODE = 1
}
`;

let root: string;
let remote: string;
let clone: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "archestra-cursor-ps-"));
  remote = path.join(root, "remote.git");
  clone = path.join(root, "home", ".cursor", "skills", NAME);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    ...args,
  ]);
  return stdout.trim();
}

/** Replaces the marketplace with a fresh history holding one file. */
async function publishMarketplace(file: string): Promise<string> {
  const work = path.join(root, `work-${file}`);
  await rm(remote, { recursive: true, force: true });
  await git("init", "-q", "--bare", "-b", "main", remote);
  await git("init", "-q", "-b", "main", work);
  await writeFile(path.join(work, file), file);
  await git("-C", work, "add", ".");
  await git("-C", work, "commit", "-q", "-m", file);
  await git("-C", work, "push", "-q", remote, "main");
  return git("-C", work, "rev-parse", "HEAD");
}

async function runSetup(proxy: SetupScriptProxySection | null = null) {
  const script = renderSetupScript({
    clientId: "cursor",
    platform: "windows",
    appName: "Archestra",
    mcp: null,
    proxy,
    skills: { cloneUrl: remote, marketplaceName: NAME },
  } as SetupScriptContext);
  const driver = path.join(root, "setup.ps1");
  await writeFile(driver, `${WINDOWS_POWERSHELL_STDERR}${script}`);
  const appData = path.join(root, "appdata");
  await mkdir(path.join(appData, "Cursor", "User", "globalStorage"), {
    recursive: true,
  });
  await writeFile(
    path.join(appData, "Cursor", "User", "globalStorage", "state.vscdb"),
    "",
  );
  const { stdout, stderr } = await execFileAsync(
    powershellBin ?? "pwsh",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", driver],
    {
      cwd: root,
      timeout: 60_000,
      env: {
        ...process.env,
        NO_COLOR: "1",
        USERPROFILE: path.join(root, "home"),
        APPDATA: appData,
        ARCHESTRA_TEST_ROOT: root,
        ARCHESTRA_TEST_GIT: spawnSync("sh", ["-c", "command -v git"])
          .stdout.toString()
          .trim(),
      },
    },
  );
  return `${stdout}${stderr}`;
}

describe.skipIf(!powershellBin || !gitBin)(
  "Windows Cursor setup under Windows PowerShell 5.1 stderr handling",
  () => {
    test("clones the marketplace on first setup", async () => {
      const head = await publishMarketplace("a.md");

      const output = await runSetup();

      expect(output).toContain(
        `Cursor skills installed in ~/.cursor/skills/${NAME}.`,
      );
      expect(await git("-C", clone, "rev-parse", "HEAD")).toBe(head);
    });

    test("fast-forwards an earlier clone", async () => {
      await publishMarketplace("a.md");
      await runSetup();
      const work = path.join(root, "work-a.md");
      await writeFile(path.join(work, "b.md"), "b");
      await git("-C", work, "add", ".");
      await git("-C", work, "commit", "-q", "-m", "b");
      await git("-C", work, "push", "-q", remote, "main");

      const output = await runSetup();

      expect(output).toContain(
        `Cursor skills installed in ~/.cursor/skills/${NAME}.`,
      );
      expect(await git("-C", clone, "rev-parse", "HEAD")).toBe(
        await git("-C", work, "rev-parse", "HEAD"),
      );
    });

    test("follows a rebuilt marketplace and finishes setup", async () => {
      await publishMarketplace("a.md");
      await runSetup();
      const rebuilt = await publishMarketplace("b.md");

      const output = await runSetup();

      expect(output).toContain(
        `Cursor skills installed in ~/.cursor/skills/${NAME}.`,
      );
      expect(output).toContain("Cursor is connected to Archestra.");
      expect(await git("-C", clone, "rev-parse", "HEAD")).toBe(rebuilt);
      expect(await readFile(path.join(clone, "b.md"), "utf8")).toBe("b.md");
    });

    test("keeps local edits when the marketplace was rebuilt", async () => {
      const earlier = await publishMarketplace("a.md");
      await runSetup();
      await publishMarketplace("b.md");
      await writeFile(path.join(clone, "a.md"), "my edit");

      const output = await runSetup();

      expect(output).toContain(
        `Cursor skills were not updated: the marketplace history changed, and ~/.cursor/skills/${NAME} has local edits.`,
      );
      expect(output).toContain("Cursor is connected to Archestra.");
      expect(await git("-C", clone, "rev-parse", "HEAD")).toBe(earlier);
      expect(await readFile(path.join(clone, "a.md"), "utf8")).toBe("my edit");
    });

    test("falls back to manual model settings when Python fails", async () => {
      await publishMarketplace("a.md");

      const output = await runSetup({
        url: "https://archestra.example.com/v1/model-router",
        virtualKey: "arch_cursor_test",
        cursorModels: { ids: ["openai:gpt-5.4"], defaultId: "openai:gpt-5.4" },
      } as SetupScriptProxySection);

      expect(output).toContain(
        "Could not update Cursor's settings automatically",
      );
      expect(output).toContain("Cursor is connected to Archestra.");
    });
  },
);
