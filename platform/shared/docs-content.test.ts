import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("docs content", () => {
  it("keeps contributing sections visible to the website table of contents", () => {
    const content = readFileSync(
      new URL("../../docs/pages/contributing.md", import.meta.url),
      "utf8",
    );

    const h2Headings = Array.from(content.matchAll(/^##\s+(.+)$/gm)).map(
      ([, heading]) => heading,
    );

    expect(h2Headings).toHaveLength(3);
    expect(h2Headings[0]).toContain("Talk to Us First!");
    expect(h2Headings[1]).toContain("Contribute Responsibly");
    expect(h2Headings[2]).toBe("Bounties");
  });
});
