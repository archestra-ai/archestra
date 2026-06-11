import { McpCatalogFormValues } from "./mcp-catalog-form.types";

/**
 * Parses various MCP server config formats into McpCatalogFormValues.
 */
export function parseSmartPaste(input: string): Partial<McpCatalogFormValues> | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);

    // Case 1: Simple array of arguments
    if (Array.isArray(parsed) && parsed.every(item => typeof item === "string")) {
      return { localConfig: { arguments: parsed.join("\n") } as any };
    }

    if (parsed && typeof parsed === "object") {
      const result: Partial<McpCatalogFormValues> = { localConfig: {} as any };
      let foundValidConfig = false;

      // Case 2: Archestra's own registry format
      if (parsed.server && typeof parsed.server.type === "string") {
        if (parsed.server.type === "remote") {
          result.transportType = "sse";
          result.sseConfig = { url: parsed.server.url };
          foundValidConfig = true;
        } else if (parsed.server.type === "local") {
          result.transportType = "stdio";
          result.localConfig = {
            command: parsed.server.command,
            arguments: Array.isArray(parsed.server.args) ? parsed.server.args.join("\n") : "",
            environment: []
          };
          if (parsed.server.env) {
            result.localConfig.environment = Object.entries(parsed.server.env).map(([key, value]) => ({
              key,
              type: "plain_text",
              value: String(value),
              promptOnInstallation: false
            }));
          }
          foundValidConfig = true;
        }
      }

      // Case 3: Official Registry format or "inputs" explicitly defined
      if (!foundValidConfig && parsed.servers && typeof parsed.servers === "object") {
        const servers = parsed.servers;
        const serverNames = Object.keys(servers);
        if (serverNames.length > 0) {
          const firstServer = servers[serverNames[0]];
          
          if (firstServer.type === "http" || firstServer.type === "sse") {
            result.transportType = "sse";
            result.sseConfig = { url: firstServer.url || "" };
            foundValidConfig = true;
          } else if (firstServer.command) {
            result.transportType = "stdio";
            result.localConfig = {
              command: firstServer.command,
              arguments: Array.isArray(firstServer.args) ? firstServer.args.join("\n") : "",
              environment: []
            };
            if (firstServer.env) {
              result.localConfig!.environment = Object.entries(firstServer.env).map(([key, value]) => ({
                key,
                type: "plain_text",
                value: String(value),
                promptOnInstallation: String(value).includes("<") || String(value).includes("${")
              }));
            }
            foundValidConfig = true;
          }
        }
      }

      // Case 4: Input as a placeholder string (e.g. {"sonarqube": {"command": "docker", "args": []}})
      if (!foundValidConfig) {
        const rootKeys = Object.keys(parsed);
        if (rootKeys.length > 0 && typeof parsed[rootKeys[0]] === "object" && parsed[rootKeys[0]].command) {
          const firstServer = parsed[rootKeys[0]];
          result.transportType = "stdio";
          result.localConfig = {
            command: firstServer.command,
            arguments: Array.isArray(firstServer.args) ? firstServer.args.join("\n") : "",
            environment: []
          };
          if (firstServer.env) {
            result.localConfig!.environment = Object.entries(firstServer.env).map(([key, value]) => ({
              key,
              type: "plain_text",
              value: String(value),
              promptOnInstallation: String(value).includes("<") || String(value).includes("${")
            }));
          }
          foundValidConfig = true;
        }
      }

      if (foundValidConfig) return result;
    }
  } catch (e) {
    // Not valid JSON
  }

  return null;
}
