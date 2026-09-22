import { describe, expect, test } from "vitest";
import { collectDeclaredToolNames } from "./declared-tool-names";

describe("collectDeclaredToolNames", () => {
  describe("Anthropic messages", () => {
    // Built-ins carry a `type` and no input schema, so getTools() drops them.
    // The caller runs them itself, so the availability set has to count them.
    test("counts custom tools and schema-less built-ins alike", () => {
      expect(
        collectDeclaredToolNames({
          tools: [
            {
              name: "github__list_issues",
              description: "list issues",
              input_schema: { type: "object", properties: {} },
            },
            { type: "bash_20250124", name: "bash" },
            { type: "text_editor_20250124", name: "str_replace_editor" },
          ],
        }),
      ).toEqual([
        { name: "github__list_issues" },
        { name: "bash" },
        { name: "str_replace_editor" },
      ]);
    });

    test("a request declaring only built-ins still names them", () => {
      expect(
        collectDeclaredToolNames({
          tools: [{ type: "bash_20250124", name: "bash" }],
        }),
      ).toEqual([{ name: "bash" }]);
    });
  });

  describe("OpenAI chat completions", () => {
    test("names function tools", () => {
      expect(
        collectDeclaredToolNames({
          tools: [
            {
              type: "function",
              function: { name: "get_weather", parameters: {} },
            },
          ],
        }),
      ).toEqual([{ name: "get_weather" }]);
    });

    // Freeform custom tools name themselves under `custom`, not `function`, so
    // the adapter's function-only view drops them entirely.
    test("names freeform custom tools alongside function tools", () => {
      expect(
        collectDeclaredToolNames({
          tools: [
            { type: "function", function: { name: "get_weather" } },
            { type: "custom", custom: { name: "run_sql" } },
          ],
        }),
      ).toEqual([{ name: "get_weather" }, { name: "run_sql" }]);
    });
  });

  describe("OpenAI Responses", () => {
    // Responses tools name themselves at the top level, and everything that is
    // not `type: "function"` is dropped by the adapter's view.
    test("names function tools and provider built-ins", () => {
      expect(
        collectDeclaredToolNames({
          tools: [
            { type: "function", name: "Grep", parameters: {} },
            { type: "web_search" },
            { type: "computer_use_preview", name: "computer" },
          ],
        }),
      ).toEqual([{ name: "Grep" }, { name: "computer" }]);
    });

    // Codex groups an MCP server's tools under one namespace and calls each
    // member by its own name in that namespace. The namespace itself is not
    // a tool anyone calls.
    test("names Codex namespace members with their namespace, never the namespace itself", () => {
      expect(
        collectDeclaredToolNames({
          tools: [
            { type: "function", name: "shell" },
            {
              type: "namespace",
              name: "mcp__gw",
              description: "Tools of the gw server.",
              tools: [
                { type: "function", name: "archestra__run_tool" },
                { type: "function", name: "archestra__search_tools" },
              ],
            },
          ],
        }),
      ).toEqual([
        { name: "shell" },
        { name: "archestra__run_tool", namespace: "mcp__gw" },
        { name: "archestra__search_tools", namespace: "mcp__gw" },
      ]);
    });

    test("reads additional_tools, top-level and as input items", () => {
      expect(
        collectDeclaredToolNames({
          additional_tools: [{ type: "function", name: "top_level" }],
          input: [
            { role: "user", content: "hi" },
            {
              type: "additional_tools",
              tools: [
                {
                  type: "namespace",
                  name: "mcp__gw",
                  tools: [{ type: "function", name: "archestra__run_tool" }],
                },
              ],
            },
          ],
        }),
      ).toEqual([
        { name: "top_level" },
        { name: "archestra__run_tool", namespace: "mcp__gw" },
      ]);
    });

    // A model with tool search calls the tools the search loaded, which
    // are declared nowhere else.
    test("reads the tools a client-run tool search loaded", () => {
      expect(
        collectDeclaredToolNames({
          tools: [
            { type: "function", name: "shell" },
            { type: "tool_search", execution: "client", parameters: {} },
          ],
          input: [
            {
              type: "tool_search_output",
              call_id: "ts_1",
              execution: "client",
              tools: [
                {
                  type: "namespace",
                  name: "mcp__gw",
                  tools: [{ type: "function", name: "archestra__run_tool" }],
                },
                { type: "function", name: "lookup" },
              ],
            },
          ],
        }),
      ).toEqual([
        { name: "shell" },
        { name: "archestra__run_tool", namespace: "mcp__gw" },
        { name: "lookup" },
      ]);
    });
  });

  describe("other provider shapes", () => {
    test("Gemini groups declarations under one tool entry", () => {
      expect(
        collectDeclaredToolNames({
          tools: [
            {
              functionDeclarations: [
                { name: "get_weather" },
                { name: "get_time" },
              ],
            },
          ],
        }),
      ).toEqual([{ name: "get_weather" }, { name: "get_time" }]);
    });

    // Reading must not change the body: a rewritten Gemini container would
    // change every Gemini request that passes through.
    test("Gemini accepts a lone tool object instead of an array, which stays one", () => {
      const request = {
        tools: { functionDeclarations: [{ name: "get_weather" }] },
      };
      expect(collectDeclaredToolNames(request)).toEqual([
        { name: "get_weather" },
      ]);
      expect(request.tools).toEqual({
        functionDeclarations: [{ name: "get_weather" }],
      });
    });

    test("Bedrock Converse nests its tools under toolConfig", () => {
      expect(
        collectDeclaredToolNames({
          toolConfig: {
            tools: [{ toolSpec: { name: "get_weather", inputSchema: {} } }],
          },
        }),
      ).toEqual([{ name: "get_weather" }]);
    });
  });

  describe("entries with no usable name", () => {
    // An unusable entry must not land in the set: nothing a model can call
    // would match it, and on a request that declares nothing else it would turn
    // an empty set into a populated one — switching the check on and refusing
    // every call the caller actually declared.
    test("skips entries that name nothing", () => {
      expect(
        collectDeclaredToolNames({
          tools: [
            { type: "bash_20250124" },
            { name: "" },
            { type: "function", function: {} },
            null,
            "not-a-tool",
            { name: "kept", input_schema: { type: "object" } },
          ],
        }),
      ).toEqual([{ name: "kept" }]);
    });

    test("is empty when no tools are declared", () => {
      expect(collectDeclaredToolNames({ model: "gpt-4o" })).toEqual([]);
    });

    test("is empty for a body that is not an object", () => {
      expect(collectDeclaredToolNames(undefined)).toEqual([]);
      expect(collectDeclaredToolNames("nonsense")).toEqual([]);
    });
  });
});
