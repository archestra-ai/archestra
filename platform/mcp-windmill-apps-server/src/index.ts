import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import { z } from "zod";

/**
 * Windmill MCP Apps Server
 * Enables Archestra to manage and execute Windmill workflows.
 */
class WindmillMcpServer {
  private server: Server;
  private windmillUrl: string;
  private apiToken: string;
  private workspace: string;

  constructor() {
    this.windmillUrl = process.env.WINDMILL_URL || "https://app.windmill.dev";
    this.apiToken = process.env.WINDMILL_API_TOKEN || "";
    this.workspace = process.env.WINDMILL_WORKSPACE || "main";

    this.server = new Server(
      {
        name: "windmill-mcp-apps",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupTools();
  }

  private async fetchWindmill(endpoint: string, method: string = "GET", data?: any) {
    const url = `${this.windmillUrl}/api/w/${this.workspace}${endpoint}`;
    const response = await axios({
      url,
      method,
      data,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
      },
    });
    return response.data;
  }

  private setupTools() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "list_workflows",
          description: "List all workflows in the Windmill workspace",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "get_workflow_details",
          description: "Get detailed information and schema for a specific workflow",
          inputSchema: {
            type: "object",
            properties: {
              workflow_path: { type: "string", description: "Path to the workflow (e.g. u/user/my_flow)" },
            },
            required: ["workflow_path"],
          },
        },
        {
          name: "get_metadata",
          description: "Get metadata about this Windmill workspace integration",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "run_workflow",
          description: "Execute a Windmill workflow with arguments",
          inputSchema: {
            type: "object",
            properties: {
              workflow_path: { type: "string" },
              args: { type: "object", description: "Arguments for the workflow" },
            },
            required: ["workflow_path", "args"],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case "list_workflows":
            const workflows = await this.fetchWindmill("/flows/list");
            return {
              content: [{ type: "text", text: JSON.stringify(workflows) }],
            };

          case "get_metadata":
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    windmill_url: this.windmillUrl,
                    workspace: this.workspace,
                    integration_type: "mcp-apps",
                    logo_slug: "windmill",
                  }),
                },
              ],
            };

          case "get_workflow_details":
            const details = await this.fetchWindmill(`/flows/get/${args?.workflow_path}`);
            return {
              content: [{ type: "text", text: JSON.stringify(details) }],
            };

          case "run_workflow":
            const result = await this.fetchWindmill(
              `/jobs/run/f/${args?.workflow_path}`,
              "POST",
              args?.args
            );
            return {
              content: [
                { type: "text", text: `Workflow started. Job ID: ${result}` },
              ],
            };

          default:
            throw new Error(`Tool ${name} not found`);
        }
      } catch (error: any) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Windmill Error: ${error.response?.data?.message || error.message}`,
            },
          ],
        };
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Windmill MCP Server running on stdio");
  }
}

const server = new WindmillMcpServer();
server.run().catch(console.error);
