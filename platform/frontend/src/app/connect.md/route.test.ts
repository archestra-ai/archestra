import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("Connect agent instructions", () => {
  it("keeps Cursor's native verification steps visible after installation", async () => {
    const response = GET(new Request("http://localhost:3000/connect.md"));
    const instructions = await response.text();

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
});
