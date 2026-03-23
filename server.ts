import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { exec } from "child_process";
import fs from "fs/promises";

const server = new Server(
  {
    name: "skywork-core",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/**
 * List available tools.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "skybot_exec",
        description: "Execute a shell command in the Skywork workspace.",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string" },
          },
          required: ["command"],
        },
      },
      {
        name: "skybot_read",
        description: "Read a file from the Skywork workspace.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
        },
      },
    ],
  };
});

/**
 * Handle tool calls.
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "skybot_exec") {
    const command = args?.command as string;
    return new Promise((resolve) => {
      exec(command, (error, stdout, stderr) => {
        resolve({
          content: [{ type: "text", text: stdout || stderr || (error ? error.message : "Success") }],
        });
      });
    });
  }

  if (name === "skybot_read") {
    const path = args?.path as string;
    try {
      const content = await fs.readFile(path, "utf-8");
      return {
        content: [{ type: "text", text: content }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }

  throw new Error(`Tool not found: ${name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Skywork MCP Gateway running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
