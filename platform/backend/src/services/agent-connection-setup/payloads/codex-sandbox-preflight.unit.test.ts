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
}: {
  platform?: string;
  config?: string;
  help?: string;
  result?: ProcessResult;
  distribution?: string;
} = {}) {
  const calls: { command: string; args: string[] }[] = [];
  const run = () =>
    runInNewContext(
      `${CODEX_WSL_SETUP_HINT}\n${CODEX_SANDBOX_PREFLIGHT}\nassertSandboxReady("codex");`,
      {
        process: {
          platform,
          env: { ARCHESTRA_CODEX_WSL_DISTRIBUTION: distribution },
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
          return args[0] === "help" ? { status: 0, stdout: help } : result;
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
    expect(p.calls[0].args[3]).toContain("exec bwrap --ro-bind / /");
    expect(p.calls[0].args[3]).toContain("--unshare-net -- /bin/true");
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
