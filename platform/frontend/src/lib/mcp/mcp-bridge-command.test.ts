import { describe, expect, it } from "vitest";
import { bridgeCommand, uninstallCommand } from "./mcp-bridge-command";

describe("bridgeCommand", () => {
  it("uses the connection base URL without its /v1", () => {
    expect(bridgeCommand("https://archestra.example.com/v1", false)).toBe(
      'curl -fsSL "https://archestra.example.com/api/archestra-cli/$(uname -s)-$(uname -m)" -o archestra \\\n' +
        "  && chmod +x archestra && ./archestra bridge start --url https://archestra.example.com",
    );
  });

  it("gives Windows a PowerShell command that works in PowerShell 5.1", () => {
    expect(bridgeCommand("https://archestra.example.com/v1", true)).toBe(
      `$ProgressPreference = 'SilentlyContinue'; irm "https://archestra.example.com/api/archestra-cli/windows-$env:PROCESSOR_ARCHITECTURE" -OutFile archestra.exe; \`\n` +
        "  if ($?) { .\\archestra.exe bridge start --url https://archestra.example.com }",
    );
    // No `&&`: Windows PowerShell 5.1 does not have it.
    expect(
      bridgeCommand("https://archestra.example.com/v1", true),
    ).not.toContain("&&");
  });

  it("accepts a base URL that ends with a slash", () => {
    for (const windows of [false, true]) {
      expect(
        bridgeCommand("https://gateway.example.com/v1/", windows),
      ).toContain("bridge start --url https://gateway.example.com");
      expect(
        bridgeCommand("https://gateway.example.com/v1/", windows),
      ).toContain('"https://gateway.example.com/api/archestra-cli/');
    }
  });

  it("keeps a path that is before /v1", () => {
    expect(bridgeCommand("https://example.com/archestra/v1", false)).toContain(
      "--url https://example.com/archestra",
    );
    expect(bridgeCommand("https://example.com/archestra/v1", true)).toContain(
      '"https://example.com/archestra/api/archestra-cli/windows-',
    );
  });

  it("keeps a base URL that has no /v1", () => {
    expect(bridgeCommand("http://localhost:3000", false)).toContain(
      "--url http://localhost:3000",
    );
  });
});

describe("uninstallCommand", () => {
  it("runs the copy that bridge start puts in the home folder", () => {
    expect(uninstallCommand(false)).toBe(
      "~/.archestra/bin/archestra uninstall",
    );
    expect(uninstallCommand(true)).toBe(
      '& "$env:USERPROFILE\\.archestra\\bin\\archestra.exe" uninstall',
    );
  });
});
