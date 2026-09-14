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
      ).toEqual(["github__list_issues", "bash", "str_replace_editor"]);
    });

    test("a request declaring only built-ins still names them", () => {
      expect(
        collectDeclaredToolNames({
          tools: [{ type: "bash_20250124", name: "bash" }],
        }),
      ).toEqual(["bash"]);
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
      ).toEqual(["get_weather"]);
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
      ).toEqual(["get_weather", "run_sql"]);
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
      ).toEqual(["Grep", "computer"]);
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
      ).toEqual(["get_weather", "get_time"]);
    });

    test("Gemini accepts a lone tool object instead of an array", () => {
      expect(
        collectDeclaredToolNames({
          tools: { functionDeclarations: [{ name: "get_weather" }] },
        }),
      ).toEqual(["get_weather"]);
    });

    test("Bedrock Converse nests its tools under toolConfig", () => {
      expect(
        collectDeclaredToolNames({
          toolConfig: {
            tools: [{ toolSpec: { name: "get_weather", inputSchema: {} } }],
          },
        }),
      ).toEqual(["get_weather"]);
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
      ).toEqual(["kept"]);
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
