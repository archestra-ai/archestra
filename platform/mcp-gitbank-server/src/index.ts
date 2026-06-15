import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";

/**
 * Gitbank MCP Server for Archestra
 * Enables on-chain budget and vault management on Base L2.
 */
class GitbankMcpServer {
  private server: Server;
  private apiBase: string = "https://gitbank.io/api/public";

  constructor() {
    this.server = new Server(
      {
        name: "gitbank-mcp",
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

  private setupTools() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "get_vault_balance",
          description: "Check USDC/WETH balance of a GitHub-linked vault",
          inputSchema: {
            type: "object",
            properties: {
              username: { type: "string", description: "GitHub username" },
            },
            required: ["username"],
          },
        },
        {
          name: "prepare_deposit",
          description: "Queue a deposit into a Gitbank vault",
          inputSchema: {
            type: "object",
            properties: {
              username: { type: "string" },
              amount: { type: "number" },
              token: { type: "string", enum: ["USDC", "WETH"] },
            },
            required: ["username", "amount", "token"],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case "get_vault_balance":
            const vault = await axios.get(`${this.apiBase}/vault/by-github/${args?.username}`);
            return { content: [{ type: "text", text: JSON.stringify(vault.data) }] };

          case "prepare_deposit":
            const deposit = await axios.get(`${this.apiBase}/prepare/deposit`, {
              params: { ...args, mode: "relayer" }
            });
            return { content: [{ type: "text", text: deposit.data.instructions }] };

          default:
            throw new Error(`Tool ${name} not found`);
        }
      } catch (error: any) {
        return {
          isError: true,
          content: [{ type: "text", text: error.response?.data?.message || error.message }],
        };
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Gitbank MCP Server running on stdio");
  }
}

const server = new GitbankMcpServer();
server.run().catch(console.error);
