import { describe, expect, it } from "vitest";
import { bridgeCommand, UNINSTALL_COMMAND } from "./mcp-bridge-command";

describe("bridgeCommand", () => {
  it("runs the install script of the deployment, at its address without /v1", () => {
    expect(bridgeCommand("https://archestra.example.com/v1", false)).toBe(
      "curl -fsSL https://archestra.example.com/api/archestra-cli/install.sh \\\n" +
        "  | sh -s -- --url https://archestra.example.com",
    );
  });

  it("gives Windows a PowerShell command that works in PowerShell 5.1", () => {
    expect(bridgeCommand("https://archestra.example.com/v1", true)).toBe(
      `$env:ARCHESTRA_URL = 'https://archestra.example.com'; \`\n` +
        `  $env:ARCHESTRA_SETUP_CODE = ''; \`\n` +
        "  irm https://archestra.example.com/api/archestra-cli/install.ps1 | iex",
    );
    // No `&&`: Windows PowerShell 5.1 does not have it.
    expect(
      bridgeCommand("https://archestra.example.com/v1", true),
    ).not.toContain("&&");
  });

  it("accepts a base URL that ends with a slash", () => {
    expect(bridgeCommand("https://gateway.example.com/v1/", false)).toContain(
      "--url https://gateway.example.com",
    );
    expect(bridgeCommand("https://gateway.example.com/v1/", true)).toContain(
      "$env:ARCHESTRA_URL = 'https://gateway.example.com';",
    );
    for (const windows of [false, true]) {
      expect(
        bridgeCommand("https://gateway.example.com/v1/", windows),
      ).toContain(" https://gateway.example.com/api/archestra-cli/install.");
    }
  });

  it("keeps a path that is before /v1", () => {
    expect(bridgeCommand("https://example.com/archestra/v1", false)).toContain(
      "--url https://example.com/archestra",
    );
    expect(bridgeCommand("https://example.com/archestra/v1", true)).toContain(
      "irm https://example.com/archestra/api/archestra-cli/install.ps1",
    );
  });

  it("passes the setup code of the dialog to the program", () => {
    expect(
      bridgeCommand(
        "https://archestra.example.com/v1",
        false,
        "AbCdEfGhIjKlMnOpQrStUv",
      ),
    ).toBe(
      "curl -fsSL https://archestra.example.com/api/archestra-cli/install.sh \\\n" +
        "  | sh -s -- --url https://archestra.example.com \\\n" +
        "    --setup-code AbCdEfGhIjKlMnOpQrStUv",
    );
    expect(
      bridgeCommand(
        "https://archestra.example.com/v1",
        true,
        "AbCdEfGhIjKlMnOpQrStUv",
      ),
    ).toContain("$env:ARCHESTRA_SETUP_CODE = 'AbCdEfGhIjKlMnOpQrStUv';");
  });

  it("keeps a base URL that has no /v1", () => {
    expect(bridgeCommand("http://localhost:3000", false)).toContain(
      "--url http://localhost:3000",
    );
  });
});

describe("UNINSTALL_COMMAND", () => {
  it("uses the bare program name, which bridge start puts on the PATH", () => {
    expect(UNINSTALL_COMMAND).toBe("archestra uninstall");
  });
});
