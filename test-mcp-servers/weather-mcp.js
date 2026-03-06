const express = require("express");
const { randomUUID } = require("crypto");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { createUIResource } = require("@mcp-ui/server");

const app = express();
app.use(express.json());

function buildWeatherHTML(city) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<style>*{margin:0;padding:0;box-sizing:border-box;font-family:system-ui,sans-serif}
body{background:linear-gradient(135deg,#1a1a2e,#0f3460);color:white;padding:16px}
.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.city{font-size:20px;font-weight:700}.condition{font-size:13px;opacity:.7}
.temp{font-size:48px;font-weight:300}.unit{font-size:24px;vertical-align:top;margin-top:8px;display:inline-block}
.forecast{display:flex;gap:8px;margin-top:14px}
.day{background:rgba(255,255,255,.1);border-radius:8px;padding:8px 12px;text-align:center;flex:1}
.day-name{font-size:11px;opacity:.7;margin-bottom:4px}.day-temp{font-size:16px;font-weight:600}.emoji{font-size:20px;margin:4px 0}
</style></head><body>
<div class="header"><div><div class="city">${city}</div><div class="condition">Partly Cloudy</div></div>
<div><span class="temp">22</span><span class="unit">°C</span></div></div>
<div class="forecast">
<div class="day"><div class="day-name">Mon</div><div class="emoji">☀️</div><div class="day-temp">24°</div></div>
<div class="day"><div class="day-name">Tue</div><div class="emoji">🌧️</div><div class="day-temp">18°</div></div>
<div class="day"><div class="day-name">Wed</div><div class="emoji">⛅</div><div class="day-temp">21°</div></div>
<div class="day"><div class="day-name">Thu</div><div class="emoji">☀️</div><div class="day-temp">26°</div></div>
<div class="day"><div class="day-name">Fri</div><div class="emoji">🌩️</div><div class="day-temp">17°</div></div>
</div></body></html>`;
}

// Stateless handler - creates fresh server per request
async function handleMCP(req, res) {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
  });
  const server = new McpServer({ name: "weather-mcp-ui", version: "1.0.0" });
  server.registerTool("get_weather", {
    title: "Get Weather",
    description: "Returns an interactive weather dashboard UI for a city",
    inputSchema: { city: { type: "string", description: "City name (e.g. Tokyo)" } },
  }, async ({ city }) => {
    const cityName = city || "Tokyo";
    const uiResource = createUIResource({
      uri: `ui://weather/${cityName.toLowerCase().replace(/\s+/g,"-")}`,
      content: { type: "rawHtml", htmlString: buildWeatherHTML(cityName) },
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

app.listen(4001, () => console.log("🌤️  Weather MCP UI → http://localhost:4001/mcp"));
