import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Stores Mcp-Session-Id values for streamable-http connections.
 *
 * When Playwright runs with --isolated, each HTTP session (identified by
 * Mcp-Session-Id) gets its own browser context.  In a multi-replica backend
 * deployment, different pods may connect to the same Playwright pod.  Without
 * sharing the session ID, each pod would get a separate browser context and
 * the browser preview would show a blank page.
 *
 * This table lets any pod look up the session ID established by the first
 * connection and reuse it, so all pods share the same browser context.
 */
const mcpHttpSessionsTable = pgTable("mcp_http_sessions", {
  connectionKey: text("connection_key").primaryKey(),
  sessionId: text("session_id").notNull(),
  sessionEndpointUrl: text("session_endpoint_url"),
  sessionEndpointPodName: text("session_endpoint_pod_name"),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
});

export default mcpHttpSessionsTable;
