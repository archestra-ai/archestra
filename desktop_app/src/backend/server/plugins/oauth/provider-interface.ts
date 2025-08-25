/**
 * OAuth Provider Interface Definitions
 *
 * This file defines the TypeScript interfaces for OAuth provider configuration.
 * Providers can either use standard environment variable patterns or implement
 * custom token handlers for special cases.
 */

/**
 * OAuth token response from the proxy server
 */
export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  // Provider-specific fields
  [key: string]: any;
}

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
 * OAuth provider definition with extensible token handling
 */
export interface OAuthProviderDefinition {
  /** Provider name (lowercase, no spaces) */
  name: string;

  /** OAuth authorization endpoint URL */
  authorizationUrl: string;

  /** OAuth scopes required by the provider */
  scopes: string[];

  /** Whether to use PKCE for enhanced security */
  usePKCE: boolean;

  /** Public client ID (not secret) */
  clientId: string;

  /**
   * Optional custom token handler for special cases.
   * If provided, this function handles token storage instead of the default env var approach.
   *
   * @param tokens - The OAuth tokens received from the provider
   * @param serverId - The MCP server ID for this installation
   * @returns Promise that resolves when tokens are stored
   *
   * @example
   * ```typescript
   * tokenHandler: async (tokens, serverId) => {
   *   // Write credentials to a file in the container
   *   await writeFileToContainer(serverId, '/path/to/credentials.json', tokens);
   * }
   * ```
   */
  tokenHandler?: (tokens: TokenResponse, serverId: string) => Promise<void>;

  /**
   * Default token environment variable pattern.
   * Used if no custom tokenHandler is provided.
   *
   * @example
   * ```typescript
   * tokenEnvVarPattern: {
   *   accessToken: 'GITHUB_ACCESS_TOKEN',
   *   refreshToken: 'GITHUB_REFRESH_TOKEN'
   * }
   * ```
   */
  tokenEnvVarPattern?: {
    /** Environment variable name for the access token */
    accessToken: string;
    /** Environment variable name for the refresh token (optional) */
    refreshToken?: string;
    /** Environment variable name for token expiry (optional) */
    expiryDate?: string;
  };

  /**
   * Optional custom authorization parameters.
   * These are added to the authorization URL.
   *
   * @example
   * ```typescript
   * authorizationParams: {
   *   prompt: 'consent',
   *   access_type: 'offline'
   * }
   * ```
   */
  authorizationParams?: Record<string, string>;

  /**
   * Whether this provider requires special authentication flow.
   * For example, Slack can use browser-based authentication.
   */
  requiresSpecialAuth?: boolean;

  /**
   * Optional metadata about the provider
   */
  metadata?: {
    /** Human-readable display name */
    displayName?: string;
    /** Provider documentation URL */
    documentationUrl?: string;
    /** Whether tokens expire and need refresh */
    supportsRefresh?: boolean;
    /** Additional notes for developers */
    notes?: string;
  };

  /**
   * Optional browser-based authentication configuration.
   * Some providers (like Slack) support extracting tokens directly from their web interface.
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
 * Registry of all OAuth providers
 */
export type OAuthProviderRegistry = Record<string, OAuthProviderDefinition>;

/**
 * OAuth installation data with provider context
 */
export interface OAuthInstallData {
  /** The provider name */
  provider: string;
  /** The MCP server being installed */
  serverId: string;
  /** OAuth state for CSRF protection */
  state: string;
  /** PKCE code verifier */
  codeVerifier?: string;
  /** Redirect URI for callback */
  redirectUri: string;
  /** Timestamp of installation start */
  timestamp: number;
}
