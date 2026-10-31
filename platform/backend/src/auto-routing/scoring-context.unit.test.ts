import { describe, expect, test } from "vitest";
import { scoringContext } from "./scoring-context";

describe("scoringContext", () => {
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
