import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, test, vi } from "vitest";
import { OPENCODE_CLIENT } from "../opencode-family";
import { MANAGED_RUNTIME_BOOTSTRAP } from "./managed-runtime-bootstrap";
import { managedRuntimeInstall } from "./managed-runtime-install";
import { STARTUP_GUARD_REFRESH } from "./startup-guard-refresh";

const require = createRequire(import.meta.url);

function windowsLoader(execFileSync: ReturnType<typeof vi.fn>) {
  const module = { exports: {} as { owned: (file: string) => void } };
  runInNewContext(MANAGED_RUNTIME_BOOTSTRAP, {
    module,
    process: { platform: "win32", env: {} },
    require: (name: string) =>
      name === "node:child_process" ? { execFileSync } : require(name),
  });
  return module.exports;
}

describe("Windows managed runtime ACL diagnostics", () => {
  test.each([
    "parent",
    "params.json",
    "launcher.cjs",
    "opencode.json",
  ])("installation reports a failure checking %s instead of declaring success", async (target) => {
    const home = await mkdtemp(path.join(tmpdir(), "windows-runtime-"));
    try {
      const configDir = path.join(home, ".config", OPENCODE_CLIENT.dir);
      await mkdir(configDir, { recursive: true });
      await writeFile(path.join(configDir, OPENCODE_CLIENT.configFile), "{}\n");
      const install = managedRuntimeInstall({
        client: OPENCODE_CLIENT,
        context: {
          clientId: "opencode",
          platform: "windows",
          appName: "Test Platform",
          mcp: null,
          proxy: null,
          skills: null,
          managedRuntimeSource: {
            installation: "11111111-1111-4111-8111-111111111111",
            url: "https://example.com/api/connection-setups/runtime",
            token: "cru1_11111111-1111-4111-8111-111111111111.example",
          },
        },
        routes: {},
        headers: {},
      });
      if (!install) throw new Error("Missing installer");
      let rejectedPath = "";
      const child = vi.fn((_exe, _args, options) => {
        const file = options.env?.ARCHESTRA_RUNTIME_ACL_PATH;
        if (!file) return "0.0.0";
        if (
          (target === "parent" && options.env.ARCHESTRA_RUNTIME_ACL_PARENT) ||
          path.basename(file) === target
        ) {
          rejectedPath = file;
          throw Object.assign(new Error("Command failed"), {
            status: 1,
            stderr: "Access is denied",
          });
        }
        return "";
      });
      const run = () =>
        runInNewContext(install.script, {
          process: {
            ...process,
            getuid: undefined,
            platform: "win32",
            env: {},
          },
          require: (name: string) => {
            if (name === "node:os") return { homedir: () => home };
            if (name === "node:child_process") return { execFileSync: child };
            return require(name);
          },
          Buffer,
        });
      expect(run).toThrow("Access is denied");
      expect(rejectedPath).not.toBe("");
      expect(run).toThrow(rejectedPath);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("installation remediates and verifies existing client config files on Windows", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "windows-runtime-"));
    try {
      const configDir = path.join(home, ".config", OPENCODE_CLIENT.dir);
      const configFile = path.join(configDir, OPENCODE_CLIENT.configFile);
      const commentedFile = path.join(
        configDir,
        OPENCODE_CLIENT.commentedConfigFile,
      );
      const tuiFile = path.join(configDir, "tui.json");
      await mkdir(configDir, { recursive: true });
      await writeFile(configFile, "{}\n");
      await writeFile(commentedFile, "{}\n");
      await writeFile(tuiFile, "{}\n");
      const install = managedRuntimeInstall({
        client: OPENCODE_CLIENT,
        context: {
          clientId: "opencode",
          platform: "windows",
          appName: "Test Platform",
          mcp: null,
          proxy: null,
          skills: null,
          managedRuntimeSource: {
            installation: "11111111-1111-4111-8111-111111111111",
            url: "https://example.com/api/connection-setups/runtime",
            token: "cru1_11111111-1111-4111-8111-111111111111.example",
          },
        },
        routes: {},
        headers: {},
      });
      if (!install) throw new Error("Missing installer");
      const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
      const child = vi.fn((_exe, args, options) => {
        if (!options?.env?.ARCHESTRA_RUNTIME_ACL_PATH) return "1.19.3";
        calls.push({ args, env: options.env });
        return "";
      });
      runInNewContext(install.script, {
        process: {
          ...process,
          getuid: undefined,
          platform: "win32",
          env: {},
        },
        require: (name: string) => {
          if (name === "node:os") return { homedir: () => home };
          if (name === "node:child_process") return { execFileSync: child };
          return require(name);
        },
        Buffer,
      });
      expect(calls[0]?.env.ARCHESTRA_RUNTIME_ACL_CONFIG?.split(";")).toEqual([
        configDir,
        configFile,
        commentedFile,
        tuiFile,
      ]);
      const verifiedNonPrivate = calls
        .slice(1)
        .filter((call) => call.env.ARCHESTRA_RUNTIME_ACL_PRIVATE === "0")
        .map((call) => call.env.ARCHESTRA_RUNTIME_ACL_PATH);
      expect(verifiedNonPrivate).toEqual(
        expect.arrayContaining([configDir, configFile, commentedFile]),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test.each([
    [
      "policy rejection",
      { status: 1, stderr: "Owner mismatch: expected user SID" },
      "Owner mismatch",
    ],
    [
      "PowerShell exception",
      { status: 1, stderr: "Get-Acl: Access is denied" },
      "Access is denied",
    ],
    ["timeout", { code: "ETIMEDOUT", signal: "SIGTERM" }, "timed out"],
    ["missing PowerShell", { code: "ENOENT" }, "ENOENT"],
  ])("identifies the checked path and %s without hiding the failure", (_name, failure, reason) => {
    const child = vi.fn(() => {
      throw Object.assign(new Error("Command failed"), failure);
    });
    const owned = windowsLoader(child).owned;
    expect(() => owned(__filename)).toThrow(__filename);
    expect(() => owned(__filename)).toThrow(reason);
  });

  test("gives the child its path, trusts SYSTEM and Administrators as owners, and allows a slow PowerShell start", () => {
    const child = vi.fn();
    windowsLoader(child).owned(__filename);
    const [, args, options] = child.mock.calls[0];
    const script = String(args[3]);
    expect(script).toContain(
      '$trusted=@($sid.Value,"S-1-5-18","S-1-5-32-544")',
    );
    expect(script).toContain("if($owner -notin $trusted)");
    expect(script).toContain("$rule.IdentityReference.Value -notin $trusted");
    expect(STARTUP_GUARD_REFRESH).toContain(
      '$trusted=@($sid.Value,"S-1-5-18","S-1-5-32-544")',
    );
    expect(STARTUP_GUARD_REFRESH).toContain(
      "if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted)",
    );
    expect(options.env).toMatchObject({
      ARCHESTRA_RUNTIME_ACL_PATH: __filename,
      ARCHESTRA_RUNTIME_ACL_PRIVATE: "1",
    });
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(options.timeout).toBeGreaterThanOrEqual(10000);
  });
});
