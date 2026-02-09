/**
 * MCP-UI Weather Wrapper
 *
 * An MCP server that wraps OpenWeatherMap API and returns rich UIResource
 * responses with visual weather cards.
 *
 * Tools:
 * - get_weather: Current weather with visual card (temp, humidity, wind, icon)
 * - get_forecast: 5-day forecast with chart visualization
 *
 * Set OPENWEATHERMAP_API_KEY env var to use real data.
 * Falls back to mock data if no API key is set.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API_KEY = process.env.OPENWEATHERMAP_API_KEY;
const BASE_URL = "https://api.openweathermap.org/data/2.5";

const server = new Server(
    { name: "mcp-ui-weather", version: "1.0.0" },
    { capabilities: { tools: { listChanged: false } } },
);

// =============================================================================
// Tool definitions
// =============================================================================

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "get_weather",
            title: "Get Current Weather",
            description:
                "Get current weather for a city. Returns a visual weather card with temperature, conditions, and details.",
            inputSchema: {
                type: "object" as const,
                properties: {
                    city: {
                        type: "string",
                        description: "City name (e.g. 'London', 'Tokyo', 'New York')",
                    },
                    units: {
                        type: "string",
                        enum: ["metric", "imperial"],
                        description: "Temperature units (default: metric)",
                    },
                },
                required: ["city"],
            },
            annotations: {},
            _meta: {},
        },
        {
            name: "get_forecast",
            title: "Get Weather Forecast",
            description:
                "Get 5-day weather forecast for a city. Returns a visual timeline with temperature trends.",
            inputSchema: {
                type: "object" as const,
                properties: {
                    city: {
                        type: "string",
                        description: "City name",
                    },
                    units: {
                        type: "string",
                        enum: ["metric", "imperial"],
                        description: "Temperature units (default: metric)",
                    },
                },
                required: ["city"],
            },
            annotations: {},
            _meta: {},
        },
    ],
}));

// =============================================================================
// Tool execution
// =============================================================================

server.setRequestHandler(
    CallToolRequestSchema,
    async ({ params: { name, arguments: args } }) => {
        switch (name) {
            case "get_weather":
                return handleGetWeather(args as { city: string; units?: string });

            case "get_forecast":
                return handleGetForecast(args as { city: string; units?: string });

            default:
                return {
                    content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
                    isError: true,
                };
        }
    },
);

// =============================================================================
// Start server
// =============================================================================

const transport = new StdioServerTransport();
await server.connect(transport);

// =============================================================================
// Tool handlers
// =============================================================================

interface WeatherData {
    name: string;
    temp: number;
    feelsLike: number;
    humidity: number;
    windSpeed: number;
    description: string;
    icon: string;
    pressure: number;
    visibility: number;
    sunrise: string;
    sunset: string;
}

async function handleGetWeather(args: { city: string; units?: string }) {
    const { city, units = "metric" } = args;
    const unitSymbol = units === "imperial" ? "°F" : "°C";
    const speedUnit = units === "imperial" ? "mph" : "m/s";

    const weather = API_KEY
        ? await fetchCurrentWeather(city, units)
        : getMockWeather(city);

    const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 0; }
  .card {
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
    color: white; border-radius: 16px; padding: 24px; min-height: 280px;
    display: flex; flex-direction: column; justify-content: space-between;
  }
  .header { display: flex; justify-content: space-between; align-items: flex-start; }
  .city-name { font-size: 24px; font-weight: 700; }
  .description { font-size: 14px; color: rgba(255,255,255,0.7); text-transform: capitalize; margin-top: 4px; }
  .icon { font-size: 48px; }
  .temp-section { display: flex; align-items: baseline; gap: 8px; margin: 20px 0; }
  .temp { font-size: 56px; font-weight: 200; }
  .unit { font-size: 24px; color: rgba(255,255,255,0.6); }
  .feels-like { font-size: 13px; color: rgba(255,255,255,0.5); }
  .details { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  .detail { text-align: center; background: rgba(255,255,255,0.08); border-radius: 12px; padding: 12px 8px; }
  .detail-icon { font-size: 20px; margin-bottom: 4px; }
  .detail-value { font-size: 16px; font-weight: 600; }
  .detail-label { font-size: 10px; color: rgba(255,255,255,0.5); text-transform: uppercase; margin-top: 2px; }
  .sun-times { display: flex; justify-content: center; gap: 24px; margin-top: 16px; font-size: 12px; color: rgba(255,255,255,0.5); }
</style>
</head><body>
<div class="card">
  <div class="header">
    <div>
      <div class="city-name">${escapeHtml(weather.name)}</div>
      <div class="description">${escapeHtml(weather.description)}</div>
    </div>
    <div class="icon">${weather.icon}</div>
  </div>

  <div class="temp-section">
    <span class="temp">${Math.round(weather.temp)}</span>
    <span class="unit">${unitSymbol}</span>
    <span class="feels-like">Feels like ${Math.round(weather.feelsLike)}${unitSymbol}</span>
  </div>

  <div class="details">
    <div class="detail">
      <div class="detail-icon">💧</div>
      <div class="detail-value">${weather.humidity}%</div>
      <div class="detail-label">Humidity</div>
    </div>
    <div class="detail">
      <div class="detail-icon">💨</div>
      <div class="detail-value">${weather.windSpeed}${speedUnit}</div>
      <div class="detail-label">Wind</div>
    </div>
    <div class="detail">
      <div class="detail-icon">🌡</div>
      <div class="detail-value">${weather.pressure}</div>
      <div class="detail-label">hPa</div>
    </div>
    <div class="detail">
      <div class="detail-icon">👁</div>
      <div class="detail-value">${(weather.visibility / 1000).toFixed(1)}km</div>
      <div class="detail-label">Visibility</div>
    </div>
  </div>

  <div class="sun-times">
    <span>🌅 ${weather.sunrise}</span>
    <span>🌇 ${weather.sunset}</span>
  </div>
</div>
</body></html>`;

    return createUiResourceResponse(`ui://weather/current/${encodeURIComponent(city)}`, html);
}

async function handleGetForecast(args: { city: string; units?: string }) {
    const { city, units = "metric" } = args;
    const unitSymbol = units === "imperial" ? "°F" : "°C";

    const forecast = API_KEY
        ? await fetchForecast(city, units)
        : getMockForecast(city);

    // Group by day (take noon readings)
    const dailyForecasts = forecast.filter((_f, i) => i % 8 === 4).slice(0, 5);

    const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 0; }
  .card {
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
    color: white; border-radius: 16px; padding: 24px;
  }
  .title { font-size: 18px; font-weight: 600; margin-bottom: 16px; }
  .subtitle { color: rgba(255,255,255,0.5); font-size: 13px; }
  .forecast-row { display: flex; gap: 8px; margin-top: 16px; }
  .day-card {
    flex: 1; text-align: center; background: rgba(255,255,255,0.06);
    border-radius: 12px; padding: 12px 4px; transition: background 0.2s;
  }
  .day-card:hover { background: rgba(255,255,255,0.12); }
  .day-name { font-size: 12px; font-weight: 600; color: rgba(255,255,255,0.7); }
  .day-icon { font-size: 28px; margin: 8px 0; }
  .day-temp { font-size: 18px; font-weight: 700; }
  .day-desc { font-size: 10px; color: rgba(255,255,255,0.5); text-transform: capitalize; margin-top: 4px; }
</style>
</head><body>
<div class="card">
  <div class="title">${escapeHtml(city)} <span class="subtitle">5-Day Forecast</span></div>
  <div class="forecast-row">
    ${dailyForecasts
            .map(
                (f) => `
    <div class="day-card">
      <div class="day-name">${f.day}</div>
      <div class="day-icon">${f.icon}</div>
      <div class="day-temp">${Math.round(f.temp)}${unitSymbol}</div>
      <div class="day-desc">${f.description}</div>
    </div>`,
            )
            .join("")}
  </div>
</div>
</body></html>`;

    return createUiResourceResponse(`ui://weather/forecast/${encodeURIComponent(city)}`, html);
}

// =============================================================================
// API fetching
// =============================================================================

async function fetchCurrentWeather(
    city: string,
    units: string,
): Promise<WeatherData> {
    const res = await fetch(
        `${BASE_URL}/weather?q=${encodeURIComponent(city)}&units=${units}&appid=${API_KEY}`,
    );
    if (!res.ok) throw new Error(`Weather API error: ${res.statusText}`);
    const data = await res.json();

    return {
        name: data.name,
        temp: data.main.temp,
        feelsLike: data.main.feels_like,
        humidity: data.main.humidity,
        windSpeed: data.wind.speed,
        description: data.weather[0].description,
        icon: weatherIcon(data.weather[0].icon),
        pressure: data.main.pressure,
        visibility: data.visibility,
        sunrise: formatTime(data.sys.sunrise),
        sunset: formatTime(data.sys.sunset),
    };
}

async function fetchForecast(
    city: string,
    units: string,
): Promise<Array<{ day: string; temp: number; description: string; icon: string }>> {
    const res = await fetch(
        `${BASE_URL}/forecast?q=${encodeURIComponent(city)}&units=${units}&appid=${API_KEY}`,
    );
    if (!res.ok) throw new Error(`Forecast API error: ${res.statusText}`);
    const data = await res.json();

    return data.list.map(
        (item: {
            dt: number;
            main: { temp: number };
            weather: Array<{ description: string; icon: string }>;
        }) => ({
            day: new Date(item.dt * 1000).toLocaleDateString("en", {
                weekday: "short",
            }),
            temp: item.main.temp,
            description: item.weather[0].description,
            icon: weatherIcon(item.weather[0].icon),
        }),
    );
}

// =============================================================================
// Mock data (for demos without API key)
// =============================================================================

function getMockWeather(city: string): WeatherData {
    return {
        name: city,
        temp: 22,
        feelsLike: 20,
        humidity: 65,
        windSpeed: 3.5,
        description: "partly cloudy",
        icon: "⛅",
        pressure: 1013,
        visibility: 10000,
        sunrise: "06:42",
        sunset: "18:15",
    };
}

function getMockForecast(
    _city: string,
): Array<{ day: string; temp: number; description: string; icon: string }> {
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri"];
    const conditions = [
        { desc: "sunny", icon: "☀️", temp: 25 },
        { desc: "partly cloudy", icon: "⛅", temp: 22 },
        { desc: "cloudy", icon: "☁️", temp: 19 },
        { desc: "light rain", icon: "🌧", temp: 17 },
        { desc: "sunny", icon: "☀️", temp: 24 },
    ];

    return Array.from({ length: 40 }, (_, i) => {
        const dayIndex = Math.floor(i / 8);
        const c = conditions[dayIndex % conditions.length];
        return {
            day: days[dayIndex % days.length],
            temp: c.temp + Math.round(Math.random() * 4 - 2),
            description: c.desc,
            icon: c.icon,
        };
    });
}

// =============================================================================
// Helpers
// =============================================================================

function createUiResourceResponse(uri: string, html: string) {
    return {
        content: [
            {
                type: "resource" as const,
                resource: {
                    uri,
                    mimeType: "text/html",
                    text: html,
                },
            },
        ],
    };
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function weatherIcon(code: string): string {
    const icons: Record<string, string> = {
        "01d": "☀️",
        "01n": "🌙",
        "02d": "⛅",
        "02n": "☁️",
        "03d": "☁️",
        "03n": "☁️",
        "04d": "☁️",
        "04n": "☁️",
        "09d": "🌧",
        "09n": "🌧",
        "10d": "🌦",
        "10n": "🌧",
        "11d": "⛈",
        "11n": "⛈",
        "13d": "🌨",
        "13n": "🌨",
        "50d": "🌫",
        "50n": "🌫",
    };
    return icons[code] || "🌡";
}

function formatTime(timestamp: number): string {
    return new Date(timestamp * 1000).toLocaleTimeString("en", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });
}
