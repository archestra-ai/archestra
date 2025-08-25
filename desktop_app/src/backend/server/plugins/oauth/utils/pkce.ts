import crypto from 'crypto';

/**
 * Generate a cryptographically secure random string for PKCE code verifier
 * Must be between 43-128 characters
 */
export function generateCodeVerifier(): string {
  return base64urlEncode(crypto.randomBytes(32));
}

/**
 * Generate code challenge from verifier using SHA256
 */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const hash = crypto.createHash('sha256').update(verifier).digest();
  return base64urlEncode(hash);
}

/**
 * Base64url encode (no padding, URL-safe characters)
 */
function base64urlEncode(buffer: Buffer): string {
  return buffer.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Generate a random state parameter for CSRF protection
 */
export function generateState(): string {
  return crypto.randomBytes(16).toString('hex');
}
