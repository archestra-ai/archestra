import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Initialize server
const server = new McpServer({
  name: "sorting-hat-mcp",
  version: "1.0.0",
});

import { getPatronusForUser, sortTool } from "./sorting-logic.js";
export { getPatronusForUser, sortTool };

// 1. sorting_hat.sort tool
server.tool(
  "sorting_hat.sort",
  "Sorts a tool invocation into a Hogwarts house (Gryffindor, Slytherin, Ravenclaw, Hufflepuff) based on risk profile and intent.",
  {
    tool_name: z.string().describe("The name of the tool to be sorted."),
    tool_description: z.string().describe("The description of the tool to be sorted."),
    please_not_slytherin: z.boolean().optional().describe("Whisper a preference to avoid Slytherin house."),
  },
  async ({ tool_name, tool_description, please_not_slytherin }) => {
    const result = sortTool(tool_name, tool_description, please_not_slytherin);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result),
        },
      ],
    };
  }
);

// 2. patronus.cast tool
server.tool(
  "patronus.cast",
  "Casts the user's Patronus charm to determine its form and whether it is corporeal.",
  {
    user_id: z.string().describe("The user ID of the wizard casting the charm."),
    charm: z.string().describe("The charm to cast, must be 'expecto_patronum'."),
  },
  async ({ user_id, charm }) => {
    if (charm !== "expecto_patronum") {
      throw new Error("Invalid charm! You must say 'expecto_patronum'.");
    }
    const patronus = getPatronusForUser(user_id);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(patronus),
        },
      ],
    };
  }
);

// 3. floo.travel tool
server.tool(
  "floo.travel",
  "Routes the tool call from the Sorting Hat to the underlying target MCP server.",
  {
    from_server: z.string().describe("The origin server name."),
    to_server: z.string().describe("The destination server name."),
    payload: z.record(z.string(), z.unknown()).describe("The tool call payload."),
  },
  async ({ from_server, to_server, payload }) => {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "success",
            flame: "green",
            message: `Successfully traveled via Floo Network from ${from_server} to ${to_server}`,
            payload,
          }),
        },
      ],
    };
  }
);

// 4. quidditch.stream tool
server.tool(
  "quidditch.stream",
  "Subscribes to progress events for a tool call to stream golden snitch updates.",
  {
    tool_call_id: z.string().describe("The tool call ID to stream progress for."),
  },
  async ({ tool_call_id }) => {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            subscribed: true,
            tool_call_id,
            stream_url: `/api/quidditch/stream/${tool_call_id}`,
          }),
        },
      ],
    };
  }
);

// Stdio server execution context check
const isMain = process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js");
if (isMain) {
  const transport = new StdioServerTransport();
  server.connect(transport).catch(console.error);
}

export { server };
