import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { parseSkillManifest } from "./parser";

// The repository's shared skills (.claude/skills links here) reach every
// coding client that opens a checkout, including Agent Runtime clients.
// GitHub Copilot CLI and this platform read their frontmatter as strict YAML
// and drop a skill they cannot parse; Claude Code accepts it anyway, so a
// broken description goes unnoticed there.
const sharedSkillsDir = path.resolve(
  import.meta.dirname,
  "../../../../.agents/skills",
);
const sharedSkills = readdirSync(sharedSkillsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

describe("repository skills", () => {
  test("the shared skills directory has skills", () => {
    expect(sharedSkills.length).toBeGreaterThan(0);
  });

  test.each(sharedSkills)("%s parses, named after its directory", (name) => {
    const manifest = readFileSync(
      path.join(sharedSkillsDir, name, "SKILL.md"),
      "utf8",
    );
    expect(parseSkillManifest(manifest).name).toBe(name);
  });
});
