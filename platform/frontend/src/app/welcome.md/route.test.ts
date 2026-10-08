// @vitest-environment node
import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("Welcome agent instructions", () => {
  it("tours the gateway at the request's origin", async () => {
    const response = GET(new Request("https://example.test/welcome.md"));
    expect(response.headers.get("Content-Type")).toBe(
      "text/plain; charset=utf-8",
    );
    const instructions = await response.text();
    expect(instructions).toContain("# Welcome");
    expect(instructions).toContain(
      "You were just connected to the MCP gateway at https://example.test.",
    );
    expect(instructions).toContain(
      "copy the connect prompt from https://example.test/connection",
    );
    expect(instructions).toContain(
      "Never send, create, edit or delete anything.",
    );
  });
});
