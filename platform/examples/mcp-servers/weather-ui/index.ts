import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createUIResource } from '@mcp-ui/server';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// Mock weather data
const weatherData: Record<string, { temp: number; conditions: string; forecast: string[] }> = {
    'New York': { temp: 72, conditions: 'Sunny', forecast: ['Mon: 75°F Sunny', 'Tue: 68°F Cloudy', 'Wed: 71°F Partly Cloudy'] },
    'London': { temp: 58, conditions: 'Rainy', forecast: ['Mon: 60°F Rainy', 'Tue: 55°F Cloudy', 'Wed: 62°F Sunny'] },
    'Tokyo': { temp: 65, conditions: 'Cloudy', forecast: ['Mon: 67°F Cloudy', 'Tue: 70°F Sunny', 'Wed: 68°F Partly Cloudy'] },
    'Sydney': { temp: 80, conditions: 'Sunny', forecast: ['Mon: 82°F Sunny', 'Tue: 78°F Sunny', 'Wed: 81°F Partly Cloudy'] },
};

const server = new Server(
    {
        name: 'weather-ui-server',
        version: '1.0.0',
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: 'get_weather_ui',
                description: 'Get weather with interactive UI widget showing current conditions and forecast',
                inputSchema: {
                    type: 'object',
                    properties: {
                        city: {
                            type: 'string',
                            description: 'City name (e.g., "New York", "London", "Tokyo", "Sydney")',
                        },
                    },
                    required: ['city'],
                },
            },
        ],
    };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === 'get_weather_ui') {
        const city = (args as { city: string }).city;
        const weather = weatherData[city] || { temp: 70, conditions: 'Unknown', forecast: ['No data'] };

        // Create interactive UI resource
        const uiResource = createUIResource({
            uri: `ui://weather/${city.replace(/\s+/g, '-').toLowerCase()}`,
            content: {
                type: 'rawHtml',
                htmlString: `
<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      margin: 0;
      padding: 20px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    .weather-card {
      background: rgba(255, 255, 255, 0.1);
      backdrop-filter: blur(10px);
      border-radius: 20px;
      padding: 30px;
      max-width: 400px;
      box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.37);
    }
    h1 {
      margin: 0 0 10px 0;
      font-size: 2.5em;
    }
    .temp {
      font-size: 4em;
      font-weight: bold;
      margin: 20px 0;
    }
    .conditions {
      font-size: 1.5em;
      opacity: 0.9;
    }
    .forecast {
      margin-top: 30px;
      padding-top: 20px;
      border-top: 1px solid rgba(255, 255, 255, 0.3);
    }
    .forecast-item {
      padding: 10px;
      margin: 5px 0;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 10px;
    }
    button {
      margin-top: 20px;
      padding: 12px 24px;
      font-size: 16px;
      font-weight: 600;
      background: rgba(255, 255, 255, 0.2);
      border: 2px solid white;
      border-radius: 10px;
      color: white;
      cursor: pointer;
      transition: all 0.3s ease;
    }
    button:hover {
      background: rgba(255, 255, 255, 0.3);
      transform: translateY(-2px);
    }
  </style>
</head>
<body>
  <div class="weather-card">
    <h1>${city}</h1>
    <div class="temp">${weather.temp}°F</div>
    <div class="conditions">${weather.conditions}</div>
    
    <div class="forecast">
      <h3>3-Day Forecast</h3>
      ${weather.forecast.map(f => `<div class="forecast-item">${f}</div>`).join('')}
    </div>
    
    <button onclick="refreshWeather()">Refresh Weather</button>
  </div>
  
  <script>
    function refreshWeather() {
      window.parent.postMessage({
        type: 'tool',
        payload: {
          toolName: 'get_weather_ui',
          params: { city: '${city}' }
        }
      }, '*');
    }
  </script>
</body>
</html>
        `,
            },
            encoding: 'text',
        });

        return {
            content: [
                {
                    type: 'text',
                    text: `Weather for ${city}: ${weather.temp}°F, ${weather.conditions}`,
                },
                uiResource,
            ],
        };
    }

    throw new Error(`Unknown tool: ${name}`);
});

// Start server
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Weather UI MCP server running on stdio');
}

main().catch((error) => {
    console.error('Server error:', error);
    process.exit(1);
});
