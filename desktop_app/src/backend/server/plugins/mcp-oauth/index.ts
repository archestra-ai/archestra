/**
 * MCP OAuth Plugin
 *
 * Clean OAuth implementation using MCP SDK's built-in OAuth functionality
 * Based on architecture from linear-mcp-oauth-minimal.ts
 */

export { McpOAuthProvider } from './provider';
export { performOAuth, refreshOAuthTokens, ensureValidTokens, areTokensExpired } from './oauth-flow';

// Main OAuth connection function for MCP servers
export { connectMcpServer } from './connection';
