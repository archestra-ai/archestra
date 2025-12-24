/**
 * Browser MCP Module
 * Enterprise-grade browser streaming for Archestra Chat UI
 * 
 * Issue: https://github.com/archestra-ai/archestra/issues/1303
 * 
 * Features:
 * - Session isolation per conversation
 * - Domain allowlist/blocklist security
 * - Secret detection to prevent credential leakage
 * - Audit logging for compliance
 * - User takeover for authentication flows
 */

export { BrowserStreamService } from './browser-stream';
export { BrowserSecurityValidator } from './browser-security';
export * from './types';
