import { describe, expect, test } from "vitest";
import {
  deriveSkillFileKind,
  extraFrontmatter,
  frontmatterSourceMatches,
  parseSkillManifest,
  SkillParseError,
} from "./parser";

describe("parseSkillManifest", () => {
  test("parses frontmatter and body", () => {
    const raw = [
      "---",
      "name: pdf-processing",
      "description: Extract text from PDF files.",
      "license: MIT",
      "---",
      "",
      "# PDF Processing",
      "Use pdftotext.",
    ].join("\n");

    const parsed = parseSkillManifest(raw);

    expect(parsed.name).toBe("pdf-processing");
    expect(parsed.description).toBe("Extract text from PDF files.");
    expect(parsed.license).toBe("MIT");
    expect(parsed.compatibility).toBeNull();
    expect(parsed.allowedTools).toBeNull();
    expect(parsed.agentName).toBeNull();
    expect(parsed.content).toBe("# PDF Processing\nUse pdftotext.");
    expect(parsed.metadata).toEqual({});
  });

  test("parses the `agent` field into agentName", () => {
    const raw = [
      "---",
      "name: deep-research",
      "description: Multi-step research.",
      "agent: Research Bot",
      "---",
      "",
      "Research deeply.",
    ].join("\n");

    expect(parseSkillManifest(raw).agentName).toBe("Research Bot");
  });

  test("treats a blank `agent` field as absent", () => {
    const raw = [
      "---",
      "name: deep-research",
      "description: Multi-step research.",
      'agent: "  "',
      "---",
      "",
      "Research deeply.",
    ].join("\n");

    expect(parseSkillManifest(raw).agentName).toBeNull();
  });

  test("parses a manifest that starts with a UTF-8 BOM", () => {
    const raw = `﻿${[
      "---",
      "name: bom-skill",
      "description: Has a byte order mark.",
      "---",
      "",
      "# Body",
    ].join("\n")}`;

    const parsed = parseSkillManifest(raw);

    expect(parsed.name).toBe("bom-skill");
    expect(parsed.description).toBe("Has a byte order mark.");
    expect(parsed.content).toBe("# Body");
  });

  test("normalizes allowed-tools from a string or a YAML sequence", () => {
    const fromString = parseSkillManifest(
      [
        "---",
        "name: git-helper",
        "description: Runs git.",
        "allowed-tools: Bash(git:*)  Read",
        "---",
        "Body.",
      ].join("\n"),
    );
    expect(fromString.allowedTools).toBe("Bash(git:*) Read");

    const fromList = parseSkillManifest(
      [
        "---",
        "name: git-helper",
        "description: Runs git.",
        "allowed-tools:",
        "  - slack__send",
        "  - jira__create",
        "---",
        "Body.",
      ].join("\n"),
    );
    expect(fromList.allowedTools).toBe("slack__send jira__create");
  });

  test("coerces the metadata map to string values", () => {
    const raw = [
      "---",
      "name: tdd",
      "description: Test-driven development.",
      "metadata:",
      "  version: 2",
      "  author: jane",
      "---",
      "Body.",
    ].join("\n");

    const parsed = parseSkillManifest(raw);

    expect(parsed.metadata).toEqual({ version: "2", author: "jane" });
  });

  test("captures the compatibility field", () => {
    const raw = [
      "---",
      "name: slack-summary",
      "description: Summarize a channel.",
      "compatibility: requires python3",
      "---",
      "Body.",
    ].join("\n");

    expect(parseSkillManifest(raw).compatibility).toBe("requires python3");
  });

  test("reads the templated flag from frontmatter, defaulting to false", () => {
    const base = ["name: greeter", "description: Greets the user."];
    const make = (extra: string[]) =>
      ["---", ...base, ...extra, "---", "Hello {{user.name}}."].join("\n");

    expect(parseSkillManifest(make([])).templated).toBe(false);
    expect(parseSkillManifest(make(["templated: true"])).templated).toBe(true);
    expect(parseSkillManifest(make(["templated: false"])).templated).toBe(
      false,
    );
  });

  test("throws when frontmatter is missing", () => {
    expect(() => parseSkillManifest("# Just markdown")).toThrow(
      SkillParseError,
    );
  });

  test("throws when name is missing", () => {
    const raw = ["---", "description: No name here.", "---", "Body."].join(
      "\n",
    );
    expect(() => parseSkillManifest(raw)).toThrow(/name/);
  });

  test("throws when description is missing", () => {
    const raw = ["---", "name: nameless", "---", "Body."].join("\n");
    expect(() => parseSkillManifest(raw)).toThrow(/description/);
  });

  test("throws on invalid YAML frontmatter", () => {
    const raw = ["---", "name: : :", "  bad", "---", "Body."].join("\n");
    expect(() => parseSkillManifest(raw)).toThrow(SkillParseError);
  });

  const messageFor = (frontmatter: string[]) => {
    try {
      parseSkillManifest(["---", ...frontmatter, "---", "Body."].join("\n"));
    } catch (error) {
      if (error instanceof SkillParseError) return error.message;
      throw error;
    }
    throw new Error("expected the manifest to be refused");
  };

  test("invalid YAML is reported as one line that names the remedy, without the parser's code frame", () => {
    const message = messageFor([
      "name: release-notes",
      "description: Use when: the user asks",
    ]);

    // The line in the file (the block starts on line 2), and what to do.
    expect(message).toContain("(line 3)");
    expect(message).toContain("wrap it in quotes");
    // js-yaml's frame is several lines with the source and a caret.
    expect(message).not.toContain("\n");
    expect(message).not.toContain("^");
    expect(message).not.toContain("bad indentation");
  });

  test.each([
    ["a number", "name: 123"],
    ["a boolean", "name: true"],
    ["a date", "name: 2026-01-01"],
    ["a list", "name: [a, b]"],
  ])("a name that YAML reads as %s is told to be text, not called missing", (_label, nameLine) => {
    const message = messageFor([nameLine, "description: A skill."]);

    expect(message).toContain("`name` must be text");
    expect(message).toContain("quotes");
    expect(message).not.toContain("missing");
  });

  test("a bare `name:` is called empty, and an absent one missing", () => {
    expect(messageFor(["name:", "description: A skill."])).toContain(
      "empty `name`",
    );
    expect(messageFor(['name: "  "', "description: A skill."])).toContain(
      "empty `name`",
    );
    expect(messageFor(["description: A skill."])).toContain("missing `name`");
  });

  test("the description is held to the same rule", () => {
    expect(messageFor(["name: a-skill", "description: 42"])).toContain(
      "`description` must be text",
    );
  });

  test("a quoted value that looked like a number or a mapping is accepted", () => {
    const parsed = parseSkillManifest(
      [
        "---",
        'name: "123"',
        'description: "Use when: the user asks"',
        "---",
        "Body.",
      ].join("\n"),
    );
    expect(parsed.name).toBe("123");
    expect(parsed.description).toBe("Use when: the user asks");
  });
});

describe("deriveSkillFileKind", () => {
  test("classifies by directory prefix", () => {
    expect(deriveSkillFileKind("scripts/fill_form.py")).toBe("script");
    expect(deriveSkillFileKind("references/FORMS.md")).toBe("reference");
    expect(deriveSkillFileKind("assets/template.json")).toBe("asset");
  });

  test("treats top-level markdown as a reference", () => {
    expect(deriveSkillFileKind("tests.md")).toBe("reference");
    expect(deriveSkillFileKind("NOTES.txt")).toBe("reference");
  });

  test("treats other top-level files as assets", () => {
    expect(deriveSkillFileKind("data.csv")).toBe("asset");
  });
});

describe("frontmatter kept as written", () => {
  const source = [
    "name: release-notes",
    "description: Draft release notes.",
    "# Which model the client runs it on",
    "model: fast",
    "argument-hint: <version>",
    "released: 2026-01-01",
    "metadata:",
    "  owner: docs",
    "  review:",
    "    required: true",
  ].join("\n");
  const parsed = parseSkillManifest(`---\n${source}\n---\n\n# Body\n`);

  test("the parsed skill carries the block between the fences, comments included", () => {
    expect(parsed.frontmatterSource).toBe(source);
    // The columns still get the flat form the Agent Skills format asks for.
    expect(parsed.metadata).toEqual({
      owner: "docs",
      review: '{"required":true}',
    });
  });

  test("the block matches the columns it was parsed into", () => {
    expect(frontmatterSourceMatches(source, parsed)).toBe(true);
  });

  test("the block stops matching once a column says something else", () => {
    // What an explicit `allowedTools` in a request body does.
    expect(
      frontmatterSourceMatches(source, { ...parsed, allowedTools: "Bash" }),
    ).toBe(false);
    expect(
      frontmatterSourceMatches(source, { ...parsed, name: "renamed" }),
    ).toBe(false);
    expect(
      frontmatterSourceMatches(source, {
        ...parsed,
        metadata: { owner: "docs" },
      }),
    ).toBe(false);
    expect(frontmatterSourceMatches("name: [unclosed", parsed)).toBe(false);
  });

  test("names what the block holds beyond the columns", () => {
    expect(extraFrontmatter(source)).toEqual({
      fields: {
        model: "fast",
        "argument-hint": "<version>",
        // Still the text that was typed, not a timestamp.
        released: "2026-01-01",
      },
      metadata: { review: { required: true } },
    });
    expect(extraFrontmatter(null)).toEqual({ fields: {}, metadata: {} });
    expect(extraFrontmatter("name: [unclosed")).toEqual({
      fields: {},
      metadata: {},
    });
  });
});
