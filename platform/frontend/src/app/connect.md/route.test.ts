import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("Connect agent instructions", () => {
  it.each([
    ["", "http://localhost:3000/connection,"],
    ["?client=unknown", "http://localhost:3000/connection,"],
    ["?client=cursor", "http://localhost:3000/connection?clientId=cursor,"],
    [
      "?client=claude-desktop&exclude=skills",
      "http://localhost:3000/connection?clientId=claude-desktop,",
    ],
  ])("points %s to the Connect page", async (query, page) => {
    const response = GET(
      new Request(`http://localhost:3000/connect.md${query}`),
    );
    const instructions = await response.text();

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(instructions).toContain(`Ask the user to open ${page}`);
    expect(instructions).toContain(
      "Do not run an installer or change any configuration from this file.",
    );
    expect(instructions).not.toContain("/api/client-connections/installer");
  });

  it("sets up only what the generic prompt did not leave out", async () => {
    const response = GET(
      new Request(
        "http://localhost:3000/connect.md?client=generic&gateway=team&exclude=skills&base=https://edge.example/v1/",
      ),
    );
    const instructions = await response.text();

    expect(instructions).toContain(
      "Gateway URL: https://edge.example/v1/mcp/team",
    );
    expect(instructions).toContain("### Model requests: LLM proxy");
    expect(instructions).not.toContain("### Skills");
    expect(instructions).toContain(
      "http://localhost:3000/disconnect.md?client=generic&base=https://edge.example/v1 and follow it.",
    );
  });

  it("never mentions the LLM proxy when it is left out", async () => {
    const instructions = await GET(
      new Request(
        "http://localhost:3000/connect.md?client=generic&gateway=team&exclude=proxy",
      ),
    ).text();

    expect(instructions).not.toMatch(/proxy/i);
  });

  it("ignores a base that is not an http(s) URL", async () => {
    const response = GET(
      new Request(
        "http://localhost:3000/connect.md?client=generic&gateway=team&base=javascript:alert(1)",
      ),
    );
    const instructions = await response.text();

    expect(instructions).toContain(
      "Gateway URL: http://localhost:3000/v1/mcp/team",
    );
    expect(instructions).toContain(
      "disconnect.md?client=generic and follow it.",
    );
  });
});
