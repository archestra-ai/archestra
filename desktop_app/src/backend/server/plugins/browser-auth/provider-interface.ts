/**
 * Browser Authentication Provider Interface Definitions
 *
 * This file defines the TypeScript interfaces for browser-based authentication provider configuration.
 * These providers extract tokens directly from authenticated browser sessions.
 */

/**
 * Browser-based authentication token response
 * Used when tokens are extracted directly from browser
 */
export interface BrowserTokenResponse {
  // The main authentication token
  primary_token: string;
  // Optional secondary token (e.g., xoxd for Slack)
  secondary_token?: string;
  // Additional metadata
  workspace_id?: string;
  user_id?: string;
  [key: string]: any;
}

/**
 * Browser authentication provider definition
 */
export interface BrowserAuthProviderDefinition {
  /** Provider name (lowercase, no spaces) */
  name: string;

  /** Whether this provider requires browser-based authentication flow */
  requiresSpecialAuth?: boolean;

  /**
   * Optional metadata about the provider
   */
  metadata?: {
    /** Human-readable display name */
    displayName?: string;
    /** Provider documentation URL */
    documentationUrl?: string;
    /** Additional notes for developers */
    notes?: string;
  };

  /**
   * Browser-based authentication configuration.
   * Required for providers that support extracting tokens directly from their web interface.
   */
  browserAuthConfig?: {
    /** Whether browser-based auth is enabled for this provider */
    enabled: boolean;
    /** URL to load for authentication */
    loginUrl: string;
    /**
     * Function to extract tokens from the authenticated browser window.
     * This function runs in the main process and can access window.webContents.
     * Should return BrowserTokenResponse or null if tokens not available.
     */
    extractTokens: (window: any) => Promise<BrowserTokenResponse | null>;
    /**
     * Environment variable mapping for browser tokens.
     * Maps BrowserTokenResponse fields to environment variables.
     */
    tokenMapping?: {
      primary: string;
      secondary?: string;
    };
    /**
     * Optional function to validate navigation URLs.
     * Return true to allow navigation, false to block.
     */
    navigationRules?: (url: string) => boolean;
    /** Optional workspace detection pattern */
    workspacePattern?: RegExp;
  };
}

/**
 * Registry of all browser authentication providers
 */
export type BrowserAuthProviderRegistry = Record<string, BrowserAuthProviderDefinition>;
