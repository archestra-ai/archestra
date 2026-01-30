/**
 * Script to add test MCPs with UI capabilities to the Archestra catalog.
 */

import { v4 as uuidv4 } from "uuid";
import InternalMcpCatalogModel from "../models/internal-mcp-catalog";
import { InsertInternalMcpCatalog } from "../types/mcp-catalog";

async function addTestMcps() {
  console.log("Adding test MCPs to catalog...");

  const testMcps: InsertInternalMcpCatalog[] = [
    {
      id: uuidv4(),
      name: "Test Simple UI",
      version: "1.0.0",
      description: "A test MCP server that provides simple HTML UI resources.",
      serverType: "remote",
      serverUrl: "http://localhost:3001/mcp",
      docsUrl: "https://mcpui.dev/guide/introduction",
      requiresAuth: false,
      authFields: [],
      userConfig: {},
      localConfig: null,
      oauthConfig: null,
    },
    {
      id: uuidv4(),
      name: "Test Interactive UI",
      version: "1.0.0",
      description: "A test MCP server that provides interactive UI components with postMessage support.",
      serverType: "remote",
      serverUrl: "http://localhost:3002/mcp",
      docsUrl: "https://mcpui.dev/guide/embeddable-ui",
      requiresAuth: false,
      authFields: [],
      userConfig: {},
      localConfig: null,
      oauthConfig: null,
    }
  ];

  for (const mcp of testMcps) {
    try {
      const existing = await InternalMcpCatalogModel.findByName(mcp.name);
      if (existing) {
        console.log(`MCP "${mcp.name}" already exists in catalog. Skipping.`);
        continue;
      }
      
      await InternalMcpCatalogModel.create(mcp);
      console.log(`✅ Added MCP "${mcp.name}" to catalog.`);
    } catch (error) {
      console.error(`Failed to add MCP "${mcp.name}":`, error);
    }
  }

  console.log("Finished adding test MCPs.");
}

// Run the script
addTestMcps().catch(console.error);
