import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("Connect agent instructions", () => {
  it("keeps the full instructions when no client is specified", async () => {
    const response = GET(new Request("http://localhost:3000/connect.md"));
    const instructions = await response.text();

    expect(instructions).toContain("## Claude Desktop");
    expect(instructions).toContain("OpenCode: run opencode mcp list first.");
    expect(instructions).toContain(
      "Cursor: installation alone is not a complete connection.",
    );
    expect(instructions).toContain(
      "the skills check, or proxy inference remain unverified, say so explicitly.",
    );
    expect(instructions).toContain(
      "never ask for the key in chat. Do not claim the proxy is configured",
    );
    expect(instructions).toContain(
      "curl --fail --silent --show-error http://localhost:3000/api/client-connections/installer",
    );
  });

  it("focuses Cursor instructions on its own setup and native checks", async () => {
    const response = GET(
      new Request("http://localhost:3000/connect.md?client=cursor"),
    );
    const instructions = await response.text();

    expect(instructions).toContain("# Connect Cursor");
    expect(instructions).toContain("--client cursor");
    expect(instructions).toContain("Customize > MCPs");
    expect(instructions).toContain("Customize > Skills");
    expect(instructions).toContain("A Cursor subscription cannot authenticate");
    expect(instructions).not.toContain("Claude Desktop");
    expect(instructions).not.toContain("opencode mcp auth");
  });

  it.each([
    ["claude-code", "Claude Code", "--client claude-code"],
    ["codex", "Codex", "--client codex"],
    ["copilot-cli", "Copilot CLI", "--client copilot-cli"],
    ["opencode", "OpenCode", "--client opencode"],
  ])("focuses %s instructions", async (client, label, command) => {
    const response = GET(
      new Request(`http://localhost:3000/connect.md?client=${client}`),
    );
    const instructions = await response.text();

    expect(instructions).toContain(`# Connect ${label}`);
    expect(instructions).toContain(command);
    expect(instructions).not.toContain("## Claude Desktop");
    expect(instructions).not.toContain("Cursor subscription");
  });

  it("focuses Claude Desktop on its host installer", async () => {
    const response = GET(
      new Request("http://localhost:3000/connect.md?client=claude-desktop"),
    );
    const instructions = await response.text();

    expect(instructions).toContain("# Connect Claude Desktop");
    expect(instructions).toContain("/connection?clientId=claude-desktop");
    expect(instructions).not.toContain("--client CLIENT_ID");
    expect(instructions).not.toContain("opencode mcp auth");
  });

  it("keeps the full instructions for an unknown client", async () => {
    const response = GET(
      new Request("http://localhost:3000/connect.md?client=unknown"),
    );
    expect(await response.text()).toContain("## Claude Desktop");
  });
});
