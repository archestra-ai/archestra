/**
 * Environment Variable Resolution Utility
 *
 * Resolves string references to environment variables in OAuth configuration objects
 */

/**
 * Recursively resolves environment variable references in an object
 * @param obj - The object to process
 * @returns The object with environment variables resolved
 */
export function resolveEnvironmentVariables<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    // Check if string matches pattern "process.env.VARIABLE_NAME"
    const envMatch = obj.match(/^process\.env\.([A-Z_][A-Z0-9_]*)$/);
    if (envMatch) {
      const envVar = envMatch[1];
      const value = process.env[envVar];
      return (value || undefined) as T;
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => resolveEnvironmentVariables(item)) as T;
  }

  if (typeof obj === 'object') {
    const resolved: any = {};
    for (const [key, value] of Object.entries(obj)) {
      resolved[key] = resolveEnvironmentVariables(value);
    }
    return resolved as T;
  }

  return obj;
}

/**
 * Specifically resolves OAuth server configuration environment variables
 * @param config - OAuth server configuration with potential env var references
 * @returns Configuration with environment variables resolved
 */
export function resolveOAuthConfig(config: any) {
  return resolveEnvironmentVariables(config);
}
