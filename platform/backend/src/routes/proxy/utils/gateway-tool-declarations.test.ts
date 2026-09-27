import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { attestToolDescription } from "@/archestra-mcp-server/tool-attestation";
import { extractGatewayToolDeclarations } from "./gateway-tool-declarations";

const ORG = "org-gateway-tool-declarations";
const GATEWAY = randomUUID();

describe("extractGatewayToolDeclarations", () => {
  describe("every declaration shape", () => {
    test("Anthropic tools carry the marker in their own description", () => {
      const body = {
        tools: [
          {
            name: "mcp__gw__archestra__run_tool",
            description: attested("archestra__run_tool", "Run a tool."),
            input_schema: { type: "object" },
          },
          { name: "Bash", description: "Run a shell command." },
        ],
        messages: [],
      };

      expect(extractGatewayToolDeclarations(body)).toEqual([
        {
          name: "mcp__gw__archestra__run_tool",
          marker: markerOf("archestra__run_tool"),
        },
        { name: "Bash" },
      ]);
      expect(body.tools.map((tool) => tool.description)).toEqual([
        "Run a tool.",
        "Run a shell command.",
      ]);
    });

    test("Chat Completions function and custom tools carry it nested", () => {
      const body = {
        tools: [
          {
            type: "function",
            function: {
              name: "gw_archestra__search_tools",
              description: attested("archestra__search_tools", "Search."),
              parameters: {},
            },
          },
          {
            type: "custom",
            custom: {
              name: "gw_github__apply",
              description: attested("github__apply", "Apply."),
            },
          },
        ],
        messages: [],
      };

      expect(extractGatewayToolDeclarations(body)).toEqual([
        {
          name: "gw_archestra__search_tools",
          marker: markerOf("archestra__search_tools"),
        },
        { name: "gw_github__apply", marker: markerOf("github__apply") },
      ]);
      expect(body.tools[0].function?.description).toBe("Search.");
      expect(body.tools[1].custom?.description).toBe("Apply.");
    });

    test("Responses top-level function tools", () => {
      const body = {
        tools: [
          {
            type: "function",
            name: "archestra__whoami",
            description: attested("archestra__whoami", "Who am I."),
          },
        ],
        input: [],
      };

      expect(extractGatewayToolDeclarations(body)).toEqual([
        { name: "archestra__whoami", marker: markerOf("archestra__whoami") },
      ]);
      expect(body.tools[0].description).toBe("Who am I.");
    });

    // Codex groups an MCP server's tools under one namespace and calls each
    // member by its bare name in that namespace.
    test("Responses namespace members come back with their namespace", () => {
      const body = {
        tools: [
          {
            type: "namespace",
            name: "mcp__gw",
            description: "Tools of the gw server.",
            tools: [
              {
                type: "function",
                name: "archestra__run_tool",
                description: attested("archestra__run_tool", "Run a tool."),
              },
            ],
          },
        ],
        input: [],
      };

      expect(extractGatewayToolDeclarations(body)).toEqual([
        {
          name: "archestra__run_tool",
          namespace: "mcp__gw",
          marker: markerOf("archestra__run_tool"),
        },
      ]);
      expect(body.tools[0].tools[0].description).toBe("Run a tool.");
      expect(body.tools[0].description).toBe("Tools of the gw server.");
    });

    test("Responses additional_tools, top-level and as input items", () => {
      const body = {
        additional_tools: [
          {
            type: "function",
            name: "archestra__search_tools",
            description: attested("archestra__search_tools", "Search."),
          },
        ],
        input: [
          {
            type: "additional_tools",
            tools: [
              {
                type: "namespace",
                name: "mcp__gw",
                tools: [
                  {
                    type: "function",
                    name: "archestra__run_tool",
                    description: attested("archestra__run_tool", "Run."),
                  },
                ],
              },
            ],
          },
        ],
      };

      expect(extractGatewayToolDeclarations(body)).toEqual([
        {
          name: "archestra__search_tools",
          marker: markerOf("archestra__search_tools"),
        },
        {
          name: "archestra__run_tool",
          namespace: "mcp__gw",
          marker: markerOf("archestra__run_tool"),
        },
      ]);
      expect(body.additional_tools[0].description).toBe("Search.");
      expect(body.input[0].tools[0].tools[0].description).toBe("Run.");
    });

    // On a model with tool search, Codex declares only the search and hands
    // the model the tools it loaded in the search's output item, grouped by
    // namespace or flat.
    test("Responses tool_search_output input items", () => {
      const runTool = {
        type: "function",
        name: "archestra__run_tool",
        description: attested("archestra__run_tool", "Run."),
      };
      const searchTools = {
        type: "function",
        name: "archestra__search_tools",
        description: attested("archestra__search_tools", "Search."),
      };
      const body = {
        tools: [{ type: "tool_search", execution: "client", parameters: {} }],
        input: [
          {
            type: "tool_search_call",
            call_id: "ts_1",
            execution: "client",
            arguments: { query: "run" },
          },
          {
            type: "tool_search_output",
            call_id: "ts_1",
            execution: "client",
            tools: [
              { type: "namespace", name: "mcp__gw", tools: [runTool] },
              searchTools,
            ],
          },
        ],
      };

      expect(extractGatewayToolDeclarations(body)).toEqual([
        {
          name: "archestra__run_tool",
          namespace: "mcp__gw",
          marker: markerOf("archestra__run_tool"),
        },
        {
          name: "archestra__search_tools",
          marker: markerOf("archestra__search_tools"),
        },
      ]);
      expect(runTool.description).toBe("Run.");
      expect(searchTools.description).toBe("Search.");
    });

    test("Gemini functionDeclarations members, which have no namespace", () => {
      const body = {
        tools: [
          {
            functionDeclarations: [
              {
                name: "archestra__run_tool",
                description: attested("archestra__run_tool", "Run."),
              },
            ],
          },
        ],
        contents: [],
      };

      expect(extractGatewayToolDeclarations(body)).toEqual([
        {
          name: "archestra__run_tool",
          marker: markerOf("archestra__run_tool"),
        },
      ]);
      expect(body.tools[0].functionDeclarations[0].description).toBe("Run.");
    });

    // Rewriting the container's shape would change every Gemini request that
    // passes through, marker or not.
    test("a lone Gemini tool object stays an object", () => {
      const body = {
        tools: {
          functionDeclarations: [
            {
              name: "archestra__run_tool",
              description: attested("archestra__run_tool", "Run."),
            },
          ],
        },
        contents: [],
      };

      expect(extractGatewayToolDeclarations(body)).toEqual([
        {
          name: "archestra__run_tool",
          marker: markerOf("archestra__run_tool"),
        },
      ]);
      expect(Array.isArray(body.tools)).toBe(false);
      expect(body.tools.functionDeclarations[0].description).toBe("Run.");
    });

    test("Bedrock Converse toolSpec", () => {
      const body = {
        toolConfig: {
          tools: [
            {
              toolSpec: {
                name: "archestra__run_tool",
                description: attested("archestra__run_tool", "Run."),
                inputSchema: {},
              },
            },
          ],
        },
        messages: [],
      };

      expect(extractGatewayToolDeclarations(body)).toEqual([
        {
          name: "archestra__run_tool",
          marker: markerOf("archestra__run_tool"),
        },
      ]);
      expect(body.toolConfig.tools[0].toolSpec.description).toBe("Run.");
    });
  });

  test("a description that held only the marker loses its key", () => {
    const tool: Record<string, unknown> = {
      name: "mcp__gw__archestra__run_tool",
      description: markerOf("archestra__run_tool"),
    };

    expect(extractGatewayToolDeclarations({ tools: [tool] })).toEqual([
      {
        name: "mcp__gw__archestra__run_tool",
        marker: markerOf("archestra__run_tool"),
      },
    ]);
    expect("description" in tool).toBe(false);
  });

  // Only a marker at the very start is the gateway's own: anything after it
  // is description text, where an upstream server could have put a copy.
  test("records only the first of two stacked markers and removes the second", () => {
    const body = {
      tools: [
        {
          name: "mcp__gw__archestra__run_tool",
          description: `${markerOf("archestra__run_tool")}\n${attested("archestra__whoami", "Run.")}`,
        },
      ],
    };

    expect(extractGatewayToolDeclarations(body)).toEqual([
      {
        name: "mcp__gw__archestra__run_tool",
        marker: markerOf("archestra__run_tool"),
      },
    ]);
    expect(body.tools[0].description).toBe("Run.");
  });

  test("a marker inside the text is removed and never recorded", () => {
    const body = {
      tools: [
        {
          name: "mcp__evil__search",
          description: `Search. ${markerOf("archestra__search_tools")} Done.`,
        },
      ],
    };

    expect(extractGatewayToolDeclarations(body)).toEqual([
      { name: "mcp__evil__search" },
    ]);
    expect(body.tools[0].description).toBe("Search.  Done.");
  });

  // Clients echo tool definitions back into the conversation (Claude Code's
  // tool search lists them in a tool result), and a model that saw a marker
  // could be asked to copy it out.
  test("removes markers from every place a client echoes them", () => {
    const echoed = attested("archestra__run_tool", "Run a tool.");
    const anthropic = {
      system: [{ type: "text", text: `Tools:\n${echoed}` }],
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "a", content: echoed },
            {
              type: "tool_result",
              tool_use_id: "b",
              content: [{ type: "text", text: `Found: ${echoed}` }],
            },
          ],
        },
      ],
    };
    const responses = {
      instructions: echoed,
      input: [{ type: "function_call_output", call_id: "c", output: echoed }],
    };
    const chat = {
      messages: [
        { role: "system", content: echoed },
        { role: "tool", tool_call_id: "d", content: echoed },
      ],
    };

    for (const body of [anthropic, responses, chat]) {
      expect(extractGatewayToolDeclarations(body)).toEqual([]);
      expect(JSON.stringify(body)).not.toContain("[[gwa1.");
    }
    expect(anthropic.messages[0].content[0].content).toBe("Run a tool.");
    expect(anthropic.system[0].text).toBe("Tools:\nRun a tool.");
    expect(responses.input[0].output).toBe("Run a tool.");
    expect(chat.messages[1].content).toBe("Run a tool.");
  });

  test("returns every declaration in order and leaves no marker in the body", () => {
    const body = {
      tools: [
        {
          name: "mcp__gw__archestra__execute_remedy_plan",
          description: attested("archestra__execute_remedy_plan", "Run."),
        },
        { name: "Read", description: "Read a file." },
        {
          type: "namespace",
          name: "mcp__gw",
          tools: [
            {
              name: "archestra__get_remedy_plans",
              description: attested("archestra__get_remedy_plans", "Plans."),
            },
          ],
        },
        { type: "web_search" },
      ],
      messages: [{ role: "user", content: `echo ${markerOf("x__y")}` }],
    };

    expect(extractGatewayToolDeclarations(body)).toEqual([
      {
        name: "mcp__gw__archestra__execute_remedy_plan",
        marker: markerOf("archestra__execute_remedy_plan"),
      },
      { name: "Read" },
      {
        name: "archestra__get_remedy_plans",
        namespace: "mcp__gw",
        marker: markerOf("archestra__get_remedy_plans"),
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("[[gwa1.");
  });

  test("leaves a body without markers untouched", () => {
    const body = {
      tools: [{ name: "Bash", description: "Run a shell command." }],
      messages: [{ role: "user", content: "hello" }],
    };
    const before = structuredClone(body);

    expect(extractGatewayToolDeclarations(body)).toEqual([{ name: "Bash" }]);
    expect(body).toEqual(before);
    expect(extractGatewayToolDeclarations(undefined)).toEqual([]);
  });
});

// === Helpers ===

/** A description minted the way the gateway serves it. */
function attested(advertisedName: string, description?: string): string {
  const served = attestToolDescription({
    organizationId: ORG,
    gatewayId: GATEWAY,
    advertisedName,
    kind: advertisedName.startsWith("archestra__") ? "b" : "t",
    description,
  });
  if (!served?.startsWith("[[gwa1.")) {
    throw new Error("attestation is off in this test environment");
  }
  return served;
}

/** The marker alone: minting is deterministic, so it matches any description's. */
function markerOf(advertisedName: string): string {
  return attested(advertisedName);
}
