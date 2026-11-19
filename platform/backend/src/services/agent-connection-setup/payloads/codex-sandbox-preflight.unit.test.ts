import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";
import { CODEX_WSL_SETUP_HINT } from "./codex-handoff";
import { CODEX_SANDBOX_PREFLIGHT } from "./codex-sandbox-preflight";

type ProcessResult = {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
};

function probe({
  platform = "linux",
  config = "",
  help = "",
  result = { status: 0 },
  distribution,
  executable,
  cacheBuilds = ["aaaabbbbccccdddd"],
  logs = {},
  locateResult,
  helpResult,
}: {
  platform?: string;
  config?: string;
  help?: string;
  result?: ProcessResult;
  distribution?: string;
  executable?: string;
  cacheBuilds?: string[];
  logs?: Record<string, string>;
  locateResult?: ProcessResult;
  helpResult?: ProcessResult;
} = {}) {
  const calls: { command: string; args: string[] }[] = [];
  const home = "/home/example/.codex";
  const mappedHome = "/mnt/c/Users/example/.codex";
  const logRoot = "/localapp/Codex/Logs";
  const files = {
    readdirSync: (dir: string, options?: { withFileTypes?: boolean }) => {
      if (dir === `${home}/bin/wsl`) return cacheBuilds;
      if (dir !== logRoot || !options?.withFileTypes) return [];
      return Object.keys(logs).map((name) => ({
        name,
        isDirectory: () => false,
        isFile: () => true,
      }));
    },
    statSync: () => ({ size: 100, mtimeMs: 1 }),
    readFileSync: (file: string) => logs[file.slice(logRoot.length + 1)],
  };
  const run = () =>
    runInNewContext(
      `${CODEX_WSL_SETUP_HINT}\n${CODEX_SANDBOX_PREFLIGHT}\nassertSandboxReady("codex");`,
      {
        process: {
          platform,
          env: {
            ARCHESTRA_CODEX_WSL_DISTRIBUTION: distribution,
            ARCHESTRA_CODEX_WSL_EXECUTABLE: executable,
            LOCALAPPDATA: "/localapp",
          },
        },
        require: (name: string) => {
          if (name !== "node:fs") throw new Error("Unexpected module");
          return files;
        },
        os: { tmpdir: () => "/tmp", homedir: () => "/home/example" },
        path: { join: (...parts: string[]) => parts.join("/") },
        existsSync: () => true,
        readFileSync: () => config,
        codexEntry: (command: string) => ({ command, args: [] }),
        codexErrorDetail: (output: ProcessResult) =>
          output.stderr || output.error?.message || "",
        spawnSync: (command: string, args: string[]) => {
          calls.push({ command, args });
          if (args.includes("archestra-wsl-codex")) {
            const offset = args.indexOf("archestra-wsl-codex");
            const binary =
              args[offset + 3] || args[offset + 2].replace(home, mappedHome);
            return (
              locateResult ?? {
                status: 0,
                stdout: `${mappedHome}\n${binary}\n`,
              }
            );
          }
          return args.at(-2) === "help" && args.at(-1) === "sandbox"
            ? (helpResult ?? { status: 0, stdout: help })
            : result;
        },
      },
    );
  return { run, calls };
}

describe("Codex local sandbox prerequisites", () => {
  test.each([
    "darwin",
    "win32",
  ])("does not require Linux dependencies for native %s", (platform) => {
    const p = probe({ platform });
    p.run();
    expect(p.calls).toEqual([]);
  });

  test.each([
    { help: "Usage: codex sandbox [COMMAND]...", legacy: false },
    { help: "Commands:\n  linux  Run a command with Landlock\n", legacy: true },
  ])("checks a real sandbox command with legacy=$legacy", ({
    help,
    legacy,
  }) => {
    const p = probe({ help });
    p.run();
    expect(p.calls.at(-1)).toEqual({
      command: "codex",
      args: [
        "sandbox",
        ...(legacy ? ["linux"] : []),
        "-c",
        'sandbox_mode="read-only"',
        "--",
        "/bin/true",
      ],
    });
  });

  test("checks WSL rather than trusting the Windows CLI when desktop WSL mode is on", () => {
    const p = probe({
      platform: "win32",
      config: "[desktop]\nrunCodexInWindowsSubsystemForLinux = true\n",
      result: { status: 127, stderr: "bubblewrap (bwrap) is missing in WSL" },
    });
    expect(p.run).toThrow("WSL's default-distribution sandbox");
    expect(p.run).toThrow("sudo apt install bubblewrap");
    expect(p.calls[0].command).toBe("wsl.exe");
    expect(p.calls[0].args.slice(0, 3)).toEqual(["--exec", "/bin/sh", "-c"]);
    expect(p.calls.at(-1)).toEqual({
      command: "wsl.exe",
      args: [
        "--exec",
        "env",
        "CODEX_HOME=/mnt/c/Users/example/.codex",
        "/mnt/c/Users/example/.codex/bin/wsl/aaaabbbbccccdddd/codex",
        "sandbox",
        "-c",
        'sandbox_mode="read-only"',
        "--",
        "/bin/true",
      ],
    });
    expect(p.calls.every((call) => !call.args.includes("bwrap"))).toBe(true);
  });

  test("targets the selected WSL distribution without interpreting its name as shell input", () => {
    const p = probe({
      platform: "win32",
      config: "[desktop]\nrunCodexInWindowsSubsystemForLinux = true\n",
      distribution: "Development Linux",
    });
    p.run();
    expect(p.calls[0].args.slice(0, 5)).toEqual([
      "--distribution",
      "Development Linux",
      "--exec",
      "/bin/sh",
      "-c",
    ]);
  });

  test.each([
    { help: "Usage: codex sandbox [COMMAND]...", legacy: false },
    { help: "Commands:\n  linux  Run a command with Landlock\n", legacy: true },
  ])("runs the desktop executable's WSL sandbox with legacy=$legacy", ({
    help,
    legacy,
  }) => {
    const p = probe({
      platform: "win32",
      config: "[desktop]\nrunCodexInWindowsSubsystemForLinux = true\n",
      help,
    });
    p.run();
    expect(p.calls.at(-1)?.args).toEqual([
      "--exec",
      "env",
      "CODEX_HOME=/mnt/c/Users/example/.codex",
      "/mnt/c/Users/example/.codex/bin/wsl/aaaabbbbccccdddd/codex",
      "sandbox",
      ...(legacy ? ["linux"] : []),
      "-c",
      'sandbox_mode="read-only"',
      "--",
      "/bin/true",
    ]);
  });

  test("chooses the desktop's most recent logged spawn across cached upgrades", () => {
    const p = probe({
      platform: "win32",
      config: "[desktop]\nrunCodexInWindowsSubsystemForLinux = true\n",
      cacheBuilds: ["1111222233334444", "aaaabbbbccccdddd"],
      logs: {
        "old.log":
          "2026-01-01T10:00:00.000Z info [StdioConnection] stdio_transport_spawned executablePath=/home/example/.codex/bin/wsl/aaaabbbbccccdddd/codex pid=1 spawnCommand=wsl.exe",
        "current.log":
          "2026-01-02T10:00:00.000Z info [StdioConnection] stdio_transport_spawned executablePath=/home/example/.codex/bin/wsl/1111222233334444/codex pid=2 spawnCommand=wsl.exe",
      },
    });
    p.run();
    expect(p.calls.at(-1)?.args).toContain(
      "/mnt/c/Users/example/.codex/bin/wsl/1111222233334444/codex",
    );
  });

  test("does not substitute an older cache when the desktop's selected binary is missing", () => {
    const p = probe({
      platform: "win32",
      config: "[desktop]\nrunCodexInWindowsSubsystemForLinux = true\n",
      logs: {
        "current.log":
          "2026-01-02T10:00:00.000Z info [StdioConnection] stdio_transport_spawned executablePath=/home/example/.codex/bin/wsl/1111222233334444/codex pid=2 spawnCommand=wsl.exe",
      },
    });
    expect(p.run).toThrow("last selected Linux Codex executable is missing");
    expect(p.calls).toEqual([]);
  });

  test("refuses ambiguous desktop versions without probing an unrelated PATH Codex", () => {
    const p = probe({
      platform: "win32",
      config: "[desktop]\nrunCodexInWindowsSubsystemForLinux = true\n",
      cacheBuilds: ["1111222233334444", "aaaabbbbccccdddd"],
    });
    expect(p.run).toThrow("ARCHESTRA_CODEX_WSL_EXECUTABLE");
    expect(p.calls).toEqual([]);
  });

  test("passes an explicit executable and distribution as data, not shell source", () => {
    const executable = "/home/example/Desktop CLI/codex;echo-untrusted";
    const p = probe({
      platform: "win32",
      config: "[desktop]\nrunCodexInWindowsSubsystemForLinux = true\n",
      cacheBuilds: [],
      distribution: "Development Linux",
      executable,
    });
    p.run();
    expect(p.calls.at(-1)?.args).toEqual([
      "--distribution",
      "Development Linux",
      "--exec",
      "env",
      "CODEX_HOME=/mnt/c/Users/example/.codex",
      executable,
      "sandbox",
      "-c",
      'sandbox_mode="read-only"',
      "--",
      "/bin/true",
    ]);
    expect(p.calls[0].args[5]).not.toContain(executable);
  });

  test("stops when WSL cannot resolve the desktop executable", () => {
    const p = probe({
      platform: "win32",
      config: "[desktop]\nrunCodexInWindowsSubsystemForLinux = true\n",
      locateResult: { status: 127, stderr: "desktop CLI unavailable" },
    });
    expect(p.run).toThrow("No client configuration was changed");
    expect(p.calls).toHaveLength(1);
  });

  test("stops before a sandbox run when the actual desktop CLI cannot report sandbox help", () => {
    const p = probe({
      platform: "win32",
      config: "[desktop]\nrunCodexInWindowsSubsystemForLinux = true\n",
      helpResult: { status: 2, stderr: "unsupported sandbox" },
    });
    expect(p.run).toThrow("Could not check the Codex sandbox");
    expect(p.calls).toHaveLength(2);
  });

  test.each([
    '["desktop"]\n"runCodexInWindowsSubsystemForLinux" = true # enabled\n',
    "'desktop'.'runCodexInWindowsSubsystemForLinux' = true\n",
    'desktop = { note = "comma, here", runCodexInWindowsSubsystemForLinux = true }\n',
    'desktop = { other = { enabled = false }, "runCodexInWindowsSubsystemForLinux" = true }\n',
  ])("recognizes WSL mode in valid TOML: %s", (config) => {
    const p = probe({ platform: "win32", config });
    p.run();
    expect(p.calls[0].command).toBe("wsl.exe");
  });

  test.each([
    "# [desktop]\n# runCodexInWindowsSubsystemForLinux = true\n",
    'notes = """\n[desktop]\nrunCodexInWindowsSubsystemForLinux = true\n"""\n',
    "notes = '''\ndesktop.runCodexInWindowsSubsystemForLinux = true\n'''\n",
    '["desktop.runCodexInWindowsSubsystemForLinux"]\nenabled = true\n',
    '"desktop.runCodexInWindowsSubsystemForLinux" = true\n',
    'desktop = { note = "runCodexInWindowsSubsystemForLinux = true", runCodexInWindowsSubsystemForLinux = false }\n',
    "desktop = { other = { runCodexInWindowsSubsystemForLinux = true } }\n",
  ])("does not infer WSL mode from unrelated TOML: %s", (config) => {
    const p = probe({ platform: "win32", config });
    p.run();
    expect(p.calls).toEqual([]);
  });

  test.each([
    { status: 101, stderr: "bubblewrap is unavailable" },
    { status: 1, stderr: "bwrap: Creating new namespace failed" },
    { status: null, error: new Error("spawn wsl.exe ENOENT") },
  ])("reports the failed sandbox instead of accepting it: $stderr$error", (result) => {
    const p = probe({ result });
    expect(p.run).toThrow("could not run a harmless command");
    expect(p.run).toThrow("Keep the sandbox enabled");
  });

  test("does not mistake an unrelated desktop switch for WSL mode", () => {
    const p = probe({
      platform: "win32",
      config: "[features]\nrunCodexInWindowsSubsystemForLinux = true\n",
      result: { status: 1 },
    });
    p.run();
    expect(p.calls).toEqual([]);
  });
});
