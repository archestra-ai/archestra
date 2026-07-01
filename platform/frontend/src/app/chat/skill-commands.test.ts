import { describe, expect, it } from "vitest";
import {
  buildSkillCommands,
  isDebugCommand,
  parseSkillCommand,
  skillCommandValue,
} from "./skill-commands";

describe("isDebugCommand", () => {
  it("matches the bare /debug command, trimmed and case-insensitive", () => {
    expect(isDebugCommand("/debug")).toBe(true);
    expect(isDebugCommand("  /debug  ")).toBe(true);
    expect(isDebugCommand("/DEBUG")).toBe(true);
  });

  it("does not match other text", () => {
    expect(isDebugCommand("/debugger")).toBe(false);
    expect(isDebugCommand("/debug hooks")).toBe(false);
    expect(isDebugCommand("debug")).toBe(false);
    expect(isDebugCommand("")).toBe(false);
  });
});

describe("skillCommandValue", () => {
  it("slugifies a skill name into a slash token", () => {
    expect(skillCommandValue("Deep Research")).toBe("/deep-research");
    expect(skillCommandValue("PDF → Markdown")).toBe("/pdf-markdown");
  });

  it("falls back to /skill for a name with no alphanumerics", () => {
    expect(skillCommandValue("✨✨")).toBe("/skill");
  });
});

describe("buildSkillCommands", () => {
  it("builds one command per skill", () => {
    const commands = buildSkillCommands([
      { id: "s1", name: "Research", description: "research things" },
      { id: "s2", name: "Summarize", description: "summarize things" },
    ]);
    expect(commands.map((c) => c.value)).toEqual(["/research", "/summarize"]);
  });

  it("disambiguates skills whose names slugify to the same token", () => {
    const commands = buildSkillCommands([
      { id: "s1", name: "PDF Tools", description: "a" },
      { id: "s2", name: "pdf-tools", description: "b" },
      { id: "s3", name: "pdf_tools", description: "c" },
    ]);
    expect(commands.map((c) => c.value)).toEqual([
      "/pdf-tools",
      "/pdf-tools-2",
      "/pdf-tools-3",
    ]);
    // each token still resolves back to its own skill
    for (const command of commands) {
      expect(parseSkillCommand(command.value, commands)?.skill).toEqual(
        command.skill,
      );
    }
  });
});

describe("parseSkillCommand", () => {
  const commands = buildSkillCommands([
    { id: "s1", name: "Research", description: "research things" },
  ]);

  it("splits the skill token from the prompt that follows it", () => {
    expect(parseSkillCommand("/research summarize this", commands)).toEqual({
      skill: { id: "s1", name: "Research" },
      value: "/research",
      remaining: "summarize this",
    });
  });

  it("returns an empty remaining for a bare skill command", () => {
    expect(parseSkillCommand("/research", commands)?.remaining).toBe("");
  });

  it("returns null for unknown tokens and plain text", () => {
    expect(parseSkillCommand("/unknown hello", commands)).toBeNull();
    expect(parseSkillCommand("just a message", commands)).toBeNull();
  });
});
