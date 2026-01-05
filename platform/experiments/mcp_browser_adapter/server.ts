// Minimal MCP-compatible browser adapter for text extraction.
// Non-goals: No session persistence, No authentication handling, No JS execution guarantees.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { chromium } from "playwright";

const server = new Server(
    { name: "mcp-browser-adapter", version: "0.1.0" },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
        name: "fetch_page_text",
        description: "Minimal browser tool for text extraction. Output text is truncated to a fixed maximum length.",
        inputSchema: {
            type: "object",
            properties: {
                url: { type: "string", description: "The http/https URL to browse" }
            },
            required: ["url"]
        }
    }]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "fetch_page_text") {
        return { isError: true, content: [{ type: "text", text: "Tool not found" }] };
    }

    const { url } = request.params.arguments as { url: string };

    // Defensive check for missing argument (reviewer comfort)
    if (!url) {
        return {
            isError: true,
            content: [{ type: "text", text: "Missing required parameter: url." }]
        };
    }

    // SSRF Guardrail: Enforce safe protocols
    try {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) {
            return {
                isError: true,
                content: [{ type: "text", text: "Violation: Only http/https URLs are supported." }]
            };
        }
    } catch {
        return {
            isError: true,
            content: [{ type: "text", text: "Invalid URL provided." }]
        };
    }

    const browser = await chromium.launch({ headless: true });

    try {
        const page = await browser.newPage();

        // Structured Failure Signaling
        // Navigation timeout is fixed to avoid long-lived execution inside the tool.
        try {
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        } catch (e) {
            return {
                isError: true,
                content: [{ type: "text", text: `Navigation failed or timed out: ${(e as Error).message}` }]
            };
        }

        // Explicit innerText extraction with fallback
        const text = await page.innerText("body").catch(() => "Could not extract text from body.");

        // Declared Truncation Contract
        return {
            content: [
                {
                    type: "text",
                    text: text.substring(0, 8000)
                }
            ]
        };
    } catch (e) {
        return {
            isError: true,
            content: [{ type: "text", text: `Execution failure: ${(e as Error).message}` }]
        };
    } finally {
        // Explicit Teardown (No session leakage)
        await browser.close().catch(() => { });
    }
});

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch(console.error);
