import { describe, expect, test } from "vitest";
import {
  deriveSkillFileKind,
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
    expect(parsed.content).toBe("# PDF Processing\nUse pdftotext.");
    expect(parsed.metadata).toEqual({});
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
