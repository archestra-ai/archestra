/**
 * ArchestraMcpClient acts as a bridge between the @mcp-ui/client components
 * and the Archestra MCP Gateway.
 * 
 * It translates JSON-RPC requests from the UI into HTTP POST requests
 * targeting the profile-specific MCP gateway endpoint.
 */
export class ArchestraMcpClient {
  constructor(private profileId: string | undefined) {}

  /**
   * Executes an MCP request via the Archestra Gateway.
   * @param request The JSON-RPC request containing method and parameters.
   * @returns The result of the MCP operation.
   */
  async request<T = unknown>(
    request: { method: string; params?: Record<string, unknown> },
    _options?: unknown
  ): Promise<T> {
    if (!this.profileId) {
      console.warn("ArchestraMcpClient: No profileId provided, cannot fetch resources");
      throw new Error("No profile context for MCP request");
    }

    try {
      const response = await fetch(`/v1/mcp/${this.profileId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: request.method,
          params: request.params,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        console.error(`MCP Gateway failed: ${response.status}`, text);
        try {
          const json = JSON.parse(text);
          throw new Error(json.error?.message || `HTTP Error ${response.status}`);
        } catch (e) {
          if (e instanceof Error && e.message.includes("HTTP Error")) throw e;
          throw new Error(`MCP Gateway Error: ${response.status}`);
        }
      }

      const data = await response.json();
      if (data.error) {
        throw new Error(data.error.message);
      }
      return data.result as T;
    } catch (error) {
      console.error("MCP Client Request Error:", error);
      throw error;
    }
  }
}
