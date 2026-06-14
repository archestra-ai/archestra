import { describe, expect, it } from "vitest";
import { composeManifest, parseManifestFields } from "./manifest-compose";

describe("composeManifest", () => {
  it("quotes frontmatter values containing YAML special characters", () => {
    const manifest = composeManifest({
      name: "postgres-warehouse",
      description: "Warehouse Postgres: projects, scaling, connectivity",
      license: "Apache-2.0: custom",
      compatibility: "Requires warehouse CLI (>= v0.294.0)",
      allowedTools: null,
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
    });
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
