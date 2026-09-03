import { describe, expect, it } from "vitest";
import {
  composeManifest,
  parseManifestFields,
  setManifestFrontmatterField,
} from "./manifest-compose";

describe("composeManifest", () => {
  it("quotes frontmatter values containing YAML special characters", () => {
    const manifest = composeManifest({
      name: "postgres-warehouse",
      description: "Warehouse Postgres: projects, scaling, connectivity",
      license: "Apache-2.0: custom",
      compatibility: "Requires warehouse CLI (>= v0.294.0)",
      allowedTools: null,
      agentName: null,
      templated: false,
      metadata: { "owner:team": "data: platform" },
      content: "# Postgres",
    });

    expect(manifest).toContain(
      'description: "Warehouse Postgres: projects, scaling, connectivity"',
    );
    expect(manifest).toContain('license: "Apache-2.0: custom"');
    expect(manifest).toContain(
      'compatibility: "Requires warehouse CLI (>= v0.294.0)"',
    );
    expect(manifest).toContain('  "owner:team": "data: platform"');
  });

  it("omits absent optional fields and appends the body after the frontmatter", () => {
    const manifest = composeManifest({
      name: "minimal",
      description: "A minimal skill.",
      license: null,
      compatibility: null,
      allowedTools: null,
      agentName: null,
      templated: false,
      metadata: {},
      content: "# Minimal\nBody text.",
    });

    expect(manifest).toBe(
      [
        "---",
        'name: "minimal"',
        'description: "A minimal skill."',
        "---",
        "",
        "# Minimal\nBody text.",
      ].join("\n"),
    );
  });

  it("emits templated and allowed-tools when set", () => {
    const manifest = composeManifest({
      name: "templated-skill",
      description: "Uses Handlebars.",
      license: null,
      compatibility: null,
      allowedTools: "Bash(python3) Read",
      agentName: null,
      templated: true,
      metadata: {},
      content: "Hello {{user.name}}",
    });

    expect(manifest).toContain('allowed-tools: "Bash(python3) Read"');
    expect(manifest).toContain("templated: true");
  });
});

describe("parseManifestFields", () => {
  it("detects name, description, and templated in the frontmatter only", () => {
    const fields = parseManifestFields(
      ["---", "name: x", "description: y", "templated: true", "---", ""].join(
        "\n",
      ),
    );
    expect(fields).toEqual({
      hasName: true,
      hasDescription: true,
      templated: true,
      name: "x",
      description: "y",
    });
  });

  it("unquotes the name value it extracts", () => {
    for (const [line, expected] of [
      ['name: "My Skill"', "My Skill"],
      ["name: 'quoted'", "quoted"],
      ["name: bare-name", "bare-name"],
    ] as const) {
      const fields = parseManifestFields(
        ["---", line, "description: y", "---"].join("\n"),
      );
      expect(fields.name).toBe(expected);
    }
  });

  it("returns a null name when the frontmatter has none", () => {
    expect(parseManifestFields("---\ndescription: y\n---").name).toBeNull();
  });

  it("treats quoted empty metadata as incomplete", () => {
    expect(
      parseManifestFields('---\nname: ""\ndescription: ""\n---'),
    ).toMatchObject({ hasName: false, hasDescription: false });
  });

  it("accepts a quoted templated value, matching the backend parser", () => {
    const fields = parseManifestFields(
      ["---", "name: x", "description: y", 'templated: "true"', "---"].join(
        "\n",
      ),
    );
    expect(fields.templated).toBe(true);
  });

  it("ignores templated mentions in the body", () => {
    const fields = parseManifestFields(
      ["---", "name: x", "description: y", "---", "templated: true"].join("\n"),
    );
    expect(fields.templated).toBe(false);
  });
});

/**
 * The skill form edits `name` and `description` as fields while the manifest
 * they live in stays editable right below them, so a write has to leave
 * everything else in the frontmatter — and in the body — exactly as it was.
 */
describe("setManifestFrontmatterField", () => {
  const manifest = [
    "---",
    'name: "old-name"',
    'description: "Old description."',
    "license: MIT",
    "metadata:",
    '  "team": "platform"',
    "---",
    "",
    "# Body",
    "name: not-frontmatter",
  ].join("\n");

  it("replaces the field in place and leaves the rest of the frontmatter", () => {
    const next = setManifestFrontmatterField({
      manifest,
      field: "name",
      value: "new-name",
    });
    expect(next).toContain('name: "new-name"');
    expect(next).not.toContain('name: "old-name"');
    expect(next).toContain("license: MIT");
    expect(next).toContain('  "team": "platform"');
    expect(next).toContain('description: "Old description."');
  });

  it("quotes the value, so a colon or a hash cannot break the YAML", () => {
    const next = setManifestFrontmatterField({
      manifest,
      field: "description",
      value: 'Ship: verify #1, then "go".',
    });
    expect(next).toContain('description: "Ship: verify #1, then \\"go\\"."');
    expect(parseManifestFields(next).description).toBe(
      'Ship: verify #1, then "go".',
    );
  });

  it("adds the field when the frontmatter does not carry it yet", () => {
    const next = setManifestFrontmatterField({
      manifest: ["---", 'name: "only-name"', "---", "", "# Body"].join("\n"),
      field: "description",
      value: "Added.",
    });
    expect(parseManifestFields(next)).toMatchObject({
      name: "only-name",
      description: "Added.",
    });
  });

  it("opens a frontmatter block for a manifest that has none", () => {
    const next = setManifestFrontmatterField({
      manifest: "# Just a body\n",
      field: "name",
      value: "fresh",
    });
    expect(parseManifestFields(next).name).toBe("fresh");
    expect(next).toContain("# Just a body");
  });

  it("does not rewrite a line in the body that looks like frontmatter", () => {
    const next = setManifestFrontmatterField({
      manifest,
      field: "name",
      value: "new-name",
    });
    // The body's own `name:` line is prose, not configuration.
    expect(next).toContain("name: not-frontmatter");
  });
});
