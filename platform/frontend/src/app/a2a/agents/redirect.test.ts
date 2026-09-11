import { describe, expect, it } from "vitest";
import { getLegacyA2aAgentsRedirect } from "./redirect";

describe("getLegacyA2aAgentsRedirect", () => {
  it("preserves supported list state for the unified agents collection", () => {
    expect(
      getLegacyA2aAgentsRedirect({
        name: "payments",
        scope: "team",
        teamIds: ["team-1", "team-2"],
        sortBy: "name",
        sortDirection: "asc",
        page: "2",
        pageSize: "25",
      }),
    ).toBe(
      "/agents?name=payments&scope=team&teamIds=team-1&teamIds=team-2&sortBy=name&sortDirection=asc&page=2&pageSize=25",
    );
  });

  it("drops unknown parameters", () => {
    expect(getLegacyA2aAgentsRedirect({ unknown: "value" })).toBe("/agents");
  });
});
