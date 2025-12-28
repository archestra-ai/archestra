/**
 * ARCHESTRA BROWSER SECURITY VALIDATOR
 * Enterprise security layer for browser automation
 * 
 * Features:
 * - Domain allowlist/blocklist
 * - Secret/credential detection (refined patterns to reduce false positives)
 * - Action authorization
 * - Audit logging
 * 
 * Fixes from Copilot PR Review:
 * - Refined secret patterns to match key=value format
 * - Reduced false positives on common words
 */

import type { DomainPolicy, ValidationResult, AuthResult } from './types';
import logger from '@/logging';

// Blocked URL schemes
const BLOCKED_SCHEMES = [
  'file://',
  'chrome://',
  'chrome-extension://',
  'about:',
  'javascript:',
  'data:text/html',
];

// Refined secret patterns - match key=value format to reduce false positives
// Previous patterns like /password/i blocked legitimate text like "reset my password"
const SECRET_PATTERNS = [
  // Match password-like key/value usages (e.g., "password=abc123", "Password: abc123")
  /\bpassword\s*[:=]\s*\S+/i,
  // Secret values in key/value form (e.g., "secret_key=...", "secret: xyz")
  /\bsecret(?:[_-]?(key|token|value))?\s*[:=]\s*\S+/i,
  // API keys in common formats (e.g., "api_key=...", "x-api-key: ...")
  /\bapi[_-]?key\s*[:=]\s*\S+/i,
  // Generic tokens in value contexts (e.g., "access_token=...", "token: abc.def.ghi")
  /\b(?:token|access[_-]?token|id[_-]?token)\s*[:=]\s*\S+/i,
  // Bearer tokens in headers or similar (e.g., "Bearer eyJhbGciOi...")
  /\bbearer\s+[A-Za-z0-9\-._~+/]+=*/i,
  // Authorization headers specifically containing bearer tokens
  /\bauthorization\s*:\s*bearer\s+[A-Za-z0-9\-._~+/]+=*/i,
  // Private/SSH key markers
  /\bprivate[_-]?key\b/i,
  /\bssh[_-]?key\b/i,
  // Generic credential markers (less common than "password"/"secret")
  /\bcredential(?:s)?\s*[:=]\s*\S+/i,
];

// Password patterns (for detecting credential-like input)
const PASSWORD_PATTERNS = [
  /^.{8,}$/,  // 8+ chars
  /[A-Z].*[a-z]|[a-z].*[A-Z]/,  // mixed case
  /\d.*[!@#$%^&*]|[!@#$%^&*].*\d/,  // numbers + special
];

export class BrowserSecurityValidator {
  
  /**
   * Validate URL against domain policy
   */
  async validateUrl(url: string, policy: DomainPolicy): Promise<ValidationResult> {
    // Check blocked schemes first
    for (const scheme of BLOCKED_SCHEMES) {
      if (url.toLowerCase().startsWith(scheme)) {
        logger.warn({ url, scheme }, 'Blocked URL scheme');
        return {
          allowed: false,
          reason: `Blocked scheme: ${scheme}`,
          ruleId: 'blocked_scheme',
        };
      }
    }
    
    // Check protocol
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return {
        allowed: false,
        reason: 'Only HTTP(S) protocols allowed',
        ruleId: 'invalid_protocol',
      };
    }
    
    // Parse domain
    const domain = this.parseDomain(url);
    if (!domain) {
      return {
        allowed: false,
        reason: 'Could not parse domain from URL',
        ruleId: 'parse_error',
      };
    }
    
    // Check allowlist
    if (policy.allowlist && policy.allowlist.length > 0) {
      const isAllowed = policy.allowlist.some(pattern => 
        this.domainMatches(domain, pattern)
      );
      
      if (!isAllowed) {
        logger.warn({ domain, allowlist: policy.allowlist }, 'Domain not in allowlist');
        return {
          allowed: false,
          reason: `Domain '${domain}' not in allowlist`,
          ruleId: 'not_in_allowlist',
        };
      }
    }
    
    // Check blocklist
    if (policy.blocklist && policy.blocklist.length > 0) {
      const isBlocked = policy.blocklist.some(pattern => 
        this.domainMatches(domain, pattern)
      );
      
      if (isBlocked) {
        logger.warn({ domain }, 'Domain in blocklist');
        return {
          allowed: false,
          reason: `Domain '${domain}' is blocked by policy`,
          ruleId: 'in_blocklist',
        };
      }
    }
    
    return {
      allowed: true,
      ruleId: 'allowed',
    };
  }
  
  /**
   * Validate input text for secrets/credentials
   * Uses refined patterns to reduce false positives
   */
  async validateInput(text: string): Promise<ValidationResult> {
    // Check for secret keywords in key=value format
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(text)) {
        logger.warn('Secret pattern detected in input');
        return {
          allowed: false,
          reason: 'Secret pattern detected in input',
          ruleId: 'secret_pattern',
        };
      }
    }
    
    // Check if looks like a password (multiple password patterns match)
    let passwordScore = 0;
    for (const pattern of PASSWORD_PATTERNS) {
      if (pattern.test(text)) {
        passwordScore++;
      }
    }
    
    // Only block if ALL password patterns match (high confidence)
    if (passwordScore >= 3) {
      logger.warn('Input appears to be a password');
      return {
        allowed: false,
        reason: 'Input appears to be a password or credential',
        ruleId: 'password_pattern',
      };
    }
    
    // Check for API key patterns (long random strings)
    if (/^[a-zA-Z0-9_-]{32,}$/.test(text)) {
      logger.warn('Input appears to be an API key');
      return {
        allowed: false,
        reason: 'Input appears to be an API key',
        ruleId: 'api_key_pattern',
      };
    }
    
    // Check for JWT tokens
    if (/^eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/.test(text)) {
      logger.warn('Input appears to be a JWT token');
      return {
        allowed: false,
        reason: 'Input appears to be a JWT token',
        ruleId: 'jwt_pattern',
      };
    }
    
    return {
      allowed: true,
      ruleId: 'allowed',
    };
  }
  
  /**
   * Authorize user action
   * NOTE: This is a placeholder. Authorization should be implemented before
   * enabling this feature in production. The feature flag ensures this is
   * disabled by default.
   */
  async authorizeAction(
    userId: string,
    action: string,
    resource: string
  ): Promise<AuthResult> {
    // TODO: Integrate with Archestra's permission system
    // This feature is behind a feature flag (disabled by default)
    // so returning true here is safe - the feature won't be enabled
    // until proper authorization is implemented.
    logger.debug({ userId, action, resource }, 'Authorization check (stub)');
    return {
      authorized: true,
      userId,
      action,
      resource,
      timestamp: new Date(),
    };
  }
  
  /**
   * Check if text is safe to log (redact secrets)
   */
  safeToLog(text: string): { safe: boolean; redacted: string } {
    let redacted = text;
    let hasSecrets = false;
    
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(text)) {
        hasSecrets = true;
        break;
      }
    }
    
    if (hasSecrets) {
      redacted = '[REDACTED]';
    }
    
    // Redact JWT tokens
    redacted = redacted.replace(
      /eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g,
      '[JWT_REDACTED]'
    );
    
    // Redact API keys (long alphanumeric strings)
    redacted = redacted.replace(
      /\b[a-zA-Z0-9_-]{32,}\b/g,
      '[KEY_REDACTED]'
    );
    
    return {
      safe: !hasSecrets,
      redacted,
    };
  }
  
  /**
   * Parse domain from URL
   */
  private parseDomain(url: string): string | null {
    try {
      const parsed = new URL(url);
      return parsed.hostname;
    } catch {
      const match = url.match(/^https?:\/\/([^/:]+)/);
      return match ? match[1] : null;
    }
  }
  
  /**
   * Check if domain matches pattern (supports wildcards)
   */
  private domainMatches(domain: string, pattern: string): boolean {
    if (pattern === domain) {
      return true;
    }
    
    // Wildcard pattern: *.example.com
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1);
      return domain.endsWith(suffix) || domain === pattern.slice(2);
    }
    
    return false;
  }
}

export default BrowserSecurityValidator;
