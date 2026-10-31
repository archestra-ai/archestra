import { describe, expect, test } from "vitest";
import { scoringContext, scoringContextFingerprint } from "./scoring-context";

describe("scoringContext", () => {
  test("fingerprints instructions and the complete tool-name set, independent of ordering and cache metadata", () => {
    const first = scoringContext({
      system: "Review migrations.",
      tools: [
        { name: "read_file", description: "Read files." },
        { name: "inspect_schema" },
      ],
    });
    const rewritten = scoringContext({
      system: [
        {
          type: "text",
          text: "Review migrations.",
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [
        { name: "inspect_schema" },
        {
          name: "read_file",
          description: "Updated description.",
          cache_control: { type: "ephemeral" },
        },
      ],
    });
    expect(scoringContextFingerprint(first)).toBe(
      scoringContextFingerprint(rewritten),
    );
    expect(scoringContextFingerprint(first)).not.toBe(
      scoringContextFingerprint({ ...first, systemPrompt: "Translate text." }),
    );
    expect(scoringContextFingerprint(first)).not.toBe(
      scoringContextFingerprint({ ...first, tools: [{ name: "read_file" }] }),
    );
    expect(scoringContextFingerprint({})).toBeUndefined();
  });
  test("extracts chat system/developer instructions and function metadata, not schemas or conversation text", () => {
    expect(
      scoringContext({
        messages: [
          { role: "system", content: "You review database migrations." },
          {
            role: "developer",
            content: [{ type: "text", text: "Check locking." }],
          },
          { role: "user", content: "Please review this change." },
          { role: "assistant", content: "Private intermediate answer" },
          { role: "tool", content: "Private tool result" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "read_file",
              description: "Read a repository file.",
              parameters: { privateSchema: "not scorer context" },
            },
          },
        ],
      }),
    ).toEqual({
      systemPrompt: "You review database migrations.\n\nCheck locking.",
      tools: [{ name: "read_file", description: "Read a repository file." }],
    });
  });

  test("extracts Anthropic system text blocks and native tools without images or cache metadata", () => {
    expect(
      scoringContext({
        system: [
          {
            type: "text",
            text: "Plan safe deployments.",
            cache_control: { type: "ephemeral" },
          },
          { type: "image", source: { data: "not text" } },
          { type: "text", text: "Ask before changing infrastructure." },
        ],
        tools: [
          {
            name: "inspect_deployment",
            description: "Read deployment status.",
            input_schema: {},
          },
        ],
      }),
    ).toEqual({
      systemPrompt:
        "Plan safe deployments.\nAsk before changing infrastructure.",
      tools: [
        { name: "inspect_deployment", description: "Read deployment status." },
      ],
    });
  });

  test("extracts Responses instructions, developer input and built-in tool types", () => {
    expect(
      scoringContext({
        instructions: "Find supporting evidence.",
        input: [
          { role: "developer", content: "Cite primary sources." },
          { role: "user", content: "Investigate." },
        ],
        tools: [
          {
            type: "function",
            name: "search_docs",
            description: "Search documentation.",
            parameters: {},
          },
          { type: "web_search" },
        ],
      }),
    ).toEqual({
      systemPrompt: "Find supporting evidence.\n\nCite primary sources.",
      tools: [
        { name: "search_docs", description: "Search documentation." },
        { name: "web_search" },
      ],
    });
  });

  test.each([
    null,
    "invalid",
    [],
    42,
  ])("ignores invalid request context: %j", (body) => {
    expect(scoringContext(body)).toEqual({});
  });

  test("preserves Responses system and developer input_text without forwarding non-text parts", () => {
    expect(
      scoringContext({
        input: [
          {
            role: "system",
            content: [
              { type: "input_text", text: "Review database migrations." },
            ],
          },
          {
            role: "developer",
            content: [
              { type: "input_text", text: "Check locking." },
              {
                type: "input_image",
                image_url: "https://example.com/private.png",
              },
            ],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: "Review this change." }],
          },
        ],
      }),
    ).toEqual({
      systemPrompt: "Review database migrations.\n\nCheck locking.",
      tools: [],
    });
  });

  test("preserves nested custom tool identity without forwarding its grammar", () => {
    expect(
      scoringContext({
        tools: [
          {
            type: "custom",
            custom: {
              name: "parse_sql",
              description: "Parse a SQL statement.",
              format: {
                type: "grammar",
                grammar: { syntax: "regex", definition: "private grammar" },
              },
            },
          },
        ],
      }),
    ).toEqual({
      systemPrompt: "",
      tools: [{ name: "parse_sql", description: "Parse a SQL statement." }],
    });
  });

  test("preserves function names when Responses descriptions are null", () => {
    expect(
      scoringContext({
        tools: [
          {
            type: "function",
            name: "lookup",
            description: null,
            parameters: null,
            strict: null,
          },
        ],
      }),
    ).toEqual({ systemPrompt: "", tools: [{ name: "lookup" }] });
  });

  test("tolerates malformed optional entries without losing valid context", () => {
    expect(
      scoringContext({
        system: 42,
        messages: [null, { role: "system", content: "Keep this instruction." }],
        tools: [null, { name: 42 }, { name: "read_file" }],
      }),
    ).toEqual({
      systemPrompt: "Keep this instruction.",
      tools: [{ name: "read_file" }],
    });
  });
});
