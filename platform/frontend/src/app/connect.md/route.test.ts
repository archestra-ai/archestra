import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("connection guide", () => {
  it("hands Claude Code setup to the user's browser without an executable command", async () => {
    const response = GET(
      new Request("https://example.com/connect.md?client=claude-code"),
    );
    const guide = await response.text();

    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(guide).toContain(
      "https://example.com/connection?clientId=claude-code",
    );
    expect(guide).toContain("Run the command yourself");
    expect(guide).toContain("In a new session, open /mcp");
    expect(guide).not.toMatch(/curl |Invoke-WebRequest|node "\$p"/);
  });

  it("preserves agent-run setup for other clients", async () => {
    const response = GET(new Request("https://example.com/connect.md"));
    const guide = await response.text();

    expect(guide).toContain("## Agent-Run Setup (Other Clients)");
    expect(guide).toContain("Invoke-WebRequest");
    expect(guide).toContain(
      "https://example.com/connection?clientId=claude-code",
    );
  });
});
