/**
 * ARCHESTRA BROWSER STREAM TYPES
 * Shared type definitions for browser MCP
 */

import type { Browser, BrowserContext, Page } from 'playwright';

/**
 * Browser session - isolated per conversation
 */
export interface BrowserSession {
  conversationId: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  orgPolicy: DomainPolicy;
  isUserControlled: boolean;
  actions: BrowserAction[];
  createdAt: Date;
}

/**
 * Domain access policy for organization
 */
export interface DomainPolicy {
  organizationId: string;
  allowlist?: string[];  // Domains allowed (supports *.example.com)
  blocklist?: string[];  // Domains blocked
  allowLocalhost?: boolean;
  requireHttps?: boolean;
}

/**
 * Browser action for audit logging
 */
export interface BrowserAction {
  type: 'navigate' | 'click' | 'type' | 'scroll' | 'auth_handoff';
  target: string;
  userId: string;
  result: 'allowed' | 'blocked';
  blockReason?: string;
  timestamp: Date;
}

/**
 * URL validation result
 */
export interface ValidationResult {
  allowed: boolean;
  reason?: string;
  ruleId: string;
}

/**
 * Action authorization result
 */
export interface AuthResult {
  authorized: boolean;
  userId: string;
  action: string;
  resource: string;
  timestamp: Date;
}

/**
 * WebSocket message types for browser stream
 */
export type BrowserStreamMessage =
  | { type: 'screenshot'; data: string; url: string; timestamp: number }
  | { type: 'action'; action: BrowserAction }
  | { type: 'error'; message: string }
  | { type: 'control'; isUserControlled: boolean };

/**
 * Browser stream API request types
 */
export interface NavigateRequest {
  conversationId: string;
  url: string;
}

export interface TypeRequest {
  conversationId: string;
  selector: string;
  text: string;
}

export interface ClickRequest {
  conversationId: string;
  selector: string;
}

export interface ControlRequest {
  conversationId: string;
  action: 'take' | 'return';
}

/**
 * Feature flag constant
 */
export const FEATURE_FLAG_BROWSER_STREAMING = 'browser-streaming';
