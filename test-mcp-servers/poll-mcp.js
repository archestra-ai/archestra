const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { createUIResource } = require("@mcp-ui/server");
const { randomUUID } = require("crypto");

const app = express();
app.use(express.json());

function buildPollHTML(question, options) {
  const opts = options.map((o, i) => `<button onclick="vote(${i})" style="display:block;width:100%;margin:6px 0;padding:10px 14px;background:rgba(255,255,255,0.1);color:white;border:1px solid rgba(255,255,255,0.2);border-radius:8px;cursor:pointer;text-align:left;font-size:14px;" onmouseover="this.style.background='rgba(99,179,237,0.3)'" onmouseout="this.style.background='rgba(255,255,255,0.1)'">${o}</button>`).join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<style>*{margin:0;padding:0;box-sizing:border-box;font-family:system-ui,sans-serif}
body{background:linear-gradient(135deg,#2d1b69,#11998e);color:white;padding:16px}
h3{font-size:15px;margin-bottom:12px;font-weight:600}
#result{display:none;padding:12px;background:rgba(255,255,255,.15);border-radius:8px;font-size:14px;margin-top:8px}
</style></head><body>
<h3>📊 ${question}</h3>${opts}
<div id="result"></div>
<script>function vote(i){document.querySelectorAll("button").forEach(b=>b.disabled=true);document.getElementById("result").style.display="block";document.getElementById("result").textContent="✅ Vote recorded! Thanks.";}</script>
</body></html>`;
}

async function handleMCP(req, res) {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = new McpServer({ name: "poll-mcp-ui", version: "1.0.0" });
  server.registerTool("create_poll", {
    title: "Create Poll",
    description: "Creates an interactive poll widget with clickable options",
    inputSchema: {
      question: { type: "string", description: "The poll question" },
      options: { type: "array", items: { type: "string" }, description: "List of poll options" },
    },
  }, async ({ question, options }) => {
    const q = question || "Which AI framework is best?";
    const opts = options || ["LangChain", "LlamaIndex", "Vercel AI SDK", "Mastra"];
    const uiResource = createUIResource({
      uri: `ui://poll/${randomUUID()}`,
      content: { type: "rawHtml", htmlString: buildPollHTML(q, opts) },
      encoding: "text",
    });
    return { content: [uiResource] };
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

app.post("/mcp", handleMCP);
app.get("/mcp", handleMCP);
app.delete("/mcp", handleMCP);

app.listen(4002, () => console.log("📊  Poll MCP UI → http://localhost:4002/mcp"));
