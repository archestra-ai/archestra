/**
 * access-control.additions.ts
 *
 * Permission additions for the MCP App proxy routes.
 *
 * HOW TO INTEGRATE:
 * In backend/src/shared/access-control.ts (or wherever RBAC permissions
 * are defined), add the "mcp-app-proxy" permission:
 *
 * The permission is: any authenticated user who has access to an agent
 * can call the proxy. The actual agent access check is done inside the
 * route handler using verifyAgentAccess().
 *
 * Add to the permissions object/enum:
 */

// Add to your permissions definition:
export const MCP_APP_PROXY_PERMISSION = {
  resource: "mcp-app-proxy",
  // Any authenticated member of the organization can use MCP App iframes
  // Agent-level access is enforced separately inside the route handler
  actions: ["read", "execute"],
  description:
    "Allows authenticated users to fetch MCP App HTML resources and " +
    "execute tool calls from within MCP App iframes, subject to agent " +
    "access control and tool visibility policies.",
} as const;

/**
 * HOW TO INTEGRATE into routes/index.ts:
 *
 * import { mcpAppProxyRoutes } from "./mcp-app-proxy";
 *
 * // Register with auth preHandler (same as other protected routes)
 * app.register(mcpAppProxyRoutes, {
 *   prefix: "",
 *   // Uses existing session auth middleware
 * });
 *
 *
 * HOW TO INTEGRATE into shared/routes.ts:
 *
 * Add route IDs:
 *
 * McpAppResourcePost: {
 *   method: "POST",
 *   path: "/api/mcp-app/resource",
 *   description: "Fetch HTML for a ui:// MCP App resource",
 * },
 * McpAppToolCallPost: {
 *   method: "POST",
 *   path: "/api/mcp-app/tool-call",
 *   description: "Execute a tool call from an MCP App iframe",
 * },
 */
